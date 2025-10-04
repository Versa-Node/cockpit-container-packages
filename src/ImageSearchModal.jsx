import React, { useState, useRef, useEffect } from 'react';
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { DataList, DataListCell, DataListItem, DataListItemCells, DataListItemRow } from "@patternfly/react-core/dist/esm/components/DataList";
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { Modal } from "@patternfly/react-core/dist/esm/components/Modal";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { ExclamationCircleIcon } from '@patternfly/react-icons';

import { EmptyStatePanel } from "cockpit-components-empty-state.jsx";
import { ErrorNotification } from './Notification.jsx';
import cockpit from 'cockpit';
import rest from './rest.js';
import * as client from './client.js';
import { fallbackRegistries, useDockerInfo } from './util.js';
import { useDialogs } from "dialogs.jsx";

import './ImageSearchModal.css';

const _ = cockpit.gettext;

// ---------- GHCR helpers (only versa-node) ----------
const GH_ORG = "versa-node"; // org is case-insensitive in API paths
const GHCR_NAMESPACE = "ghcr.io/versa-node/";
const PLACEHOLDER_DESC = "(loading description…)";

const isGhcr = (reg) => (reg || "").trim().toLowerCase() === "ghcr.io";

// user typed a GHCR versa-node reference? (either fully-qualified or org-prefixed)
const isGhcrVersaNodeTerm = (term) =>
  /^ghcr\.io\/versa-node\/[^/]+/i.test(term || "") || /^versa-node\/[^/]+/i.test(term || "");

// turn free text into the final ghcr.io/versa-node/<name>
const buildGhcrVersaNodeName = (txt) => {
  const t = (txt || "").trim()
    .replace(/^ghcr\.io\/?/i, "")
    .replace(/^versa-node\/?/i, "");
  return (GHCR_NAMESPACE + t).replace(/\/+$/, "");
};

// Extract repo name (no tag) from a ghcr.io/versa-node/* image ref
const parseGhcrRepoName = (full) => {
  if (!full) return "";
  const noTag = full.split(':')[0];
  return noTag.replace(/^ghcr\.io\/?versa-node\/?/i, "").replace(/^\/+/, "");
};

// Server-side (host) fetch via cockpit.spawn (avoids CSP).
// If token file is missing or not permitted, return an empty list silently.
async function fetchGhcrOrgPackagesViaSpawn() {
  const script = `
set -euo pipefail
URL="https://api.github.com/orgs/${GH_ORG}/packages?package_type=container&per_page=100"
HDR_ACCEPT="Accept: application/vnd.github+json"
HDR_API="X-GitHub-Api-Version: 2022-11-28"
UA="User-Agent: versanode-cockpit/1.0"
TOKEN_FILE="/etc/versanode/github.token"

if [ ! -r "$TOKEN_FILE" ]; then
  echo "[]"
  exit 0
fi

TOKEN="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
if [ -z "$TOKEN" ]; then
  echo "[]"
  exit 0
fi

set +e
RESP="$(curl -fsSL -H "$HDR_ACCEPT" -H "$HDR_API" -H "$UA" -H "Authorization: Bearer $TOKEN" "$URL")"
EC=$?
set -e
if [ $EC -ne 0 ] || [ -z "$RESP" ]; then
  echo "[]"
else
  echo "$RESP"
fi
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const pkgs = JSON.parse(out || "[]");
    console.debug("[GHCR] Org packages fetched:", pkgs.length);
    // Start with GH package description if present; we'll enrich with OCI label later.
    return (pkgs || []).map(p => ({
      name: `ghcr.io/versa-node/${p.name}`,
      description: (p.description || "").trim(),
    }));
  } catch (e) {
    console.warn("[GHCR] fetchGhcrOrgPackagesViaSpawn failed:", e?.message || e);
    return [];
  }
}

/**
 * Retrieve an anonymous (or PAT-authenticated) Bearer token for GHCR Registry v2.
 * We use the standard /token endpoint so we do NOT need to docker pull the image.
 */
async function ghcrGetRegistryTokenViaSpawn(repo) {
  const script = `
set -euo pipefail
REPO="${repo}"
UA="User-Agent: versanode-cockpit/1.0"
URL="https://ghcr.io/token?service=ghcr.io&scope=repository:versa-node/\${REPO}:pull"

# Try anonymous first
set +e
RESP="$(curl -fsSL -H "$UA" "$URL")"
EC=$?
set -e

if [ $EC -ne 0 ] || [ -z "$RESP" ]; then
  # Optional: try with PAT (if provided) using Basic auth to exchange for a token.
  TOKEN_FILE="/etc/versanode/github.token"
  if [ -r "$TOKEN_FILE" ]; then
    PAT="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
    if [ -n "$PAT" ]; then
      # GitHub accepts any username for PAT on this endpoint; 'token' is commonly used.
      BASIC="$(printf 'token:%s' "$PAT" | base64 -w0 2>/dev/null || printf 'token:%s' "$PAT" | base64)"
      set +e
      RESP="$(curl -fsSL -H "$UA" -H "Authorization: Basic $BASIC" "$URL")"
      EC=$?
      set -e
    fi
  fi
fi

if [ $EC -ne 0 ] || [ -z "$RESP" ]; then
  echo ""
else
  python3 - <<'PY' 2>/dev/null
import sys, json
try:
    print((json.load(sys.stdin).get("token") or "").strip())
except Exception:
    print("")
PY
  <<< "$RESP"
fi
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const token = (out || "").trim();
    console.debug("[GHCR] token acquired?", Boolean(token));
    return token;
  } catch (e) {
    console.warn("[GHCR] ghcrGetRegistryTokenViaSpawn failed:", e?.message || e);
    return "";
  }
}

// Fetch tags from GHCR Registry V2 API (no docker pull needed).
async function fetchGhcrTagsViaSpawn(fullName) {
  const repo = parseGhcrRepoName(fullName);
  if (!repo) return [];

  const token = await ghcrGetRegistryTokenViaSpawn(repo);
  REPO="${repo}"
  console.log("URL IS", "https://ghcr.io/v2/versa-node/\${REPO}/tags/list?n=200");
  const script = `
set -euo pipefail
REPO="${repo}"
UA="User-Agent: versanode-cockpit/1.0"
AUTH="${token ? `Authorization: Bearer ${'${TOKEN}'}"` : ""}"
TOKEN="${token || ""}"

URL="https://ghcr.io/v2/versa-node/\${REPO}/tags/list?n=200"


if [ -n "$TOKEN" ]; then
  curl -fsSL -H "$UA" -H "Accept: application/json" -H "Authorization: Bearer $TOKEN" "$URL"
else
  curl -fsSL -H "$UA" -H "Accept: application/json" "$URL"
fi
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const parsed = JSON.parse(out || '{"tags":[]}');
    const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    const uniq = Array.from(new Set(tags));
    uniq.sort((a, b) => {
      if (a === 'latest') return -1;
      if (b === 'latest') return 1;
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
    });
    console.debug("[GHCR] Tags for", fullName, "=>", uniq.slice(0, 10), uniq.length > 10 ? `(+${uniq.length - 10} more)` : "");
    return uniq;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrTagsViaSpawn failed:", e?.message || e);
    return [];
  }
}

// Fetch org.opencontainers.image.description from the OCI/Docker config for a repo:tag
// Uses token endpoint; does NOT require pulling the image locally.
async function fetchGhcrOciDescriptionViaSpawn(fullName, tagIn) {
  const repo = parseGhcrRepoName(fullName);
  let tag = (tagIn || "latest").trim();
  if (!repo) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) tag = "latest";

  const token = await ghcrGetRegistryTokenViaSpawn(repo);

  const script = `
set -euo pipefail

REPO="${repo}"
TAG="${tag}"

UA="User-Agent: versanode-cockpit/1.0"
ACCEPT_ALL="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
AUTH_H="${token ? `-H 'Authorization: Bearer ${'${TOKEN}'}'` : ""}"
TOKEN="${token || ""}"

fetch() {
  # $1: URL
  if [ -n "$TOKEN" ]; then
    curl -fsSL -H "$UA" -H "$ACCEPT_ALL" -H "Authorization: Bearer $TOKEN" "$1"
  else
    curl -fsSL -H "$UA" -H "$ACCEPT_ALL" "$1"
  fi
}

# 1) Fetch top manifest (could be index or manifest)
MAN_URL="https://ghcr.io/v2/versa-node/\${REPO}/manifests/\${TAG}"
MAN="$(fetch "$MAN_URL")" || { echo ""; exit 0; }

# 2) Examine mediaType; if index, pick linux/amd64 manifest digest
TYPE="$(python3 - <<'PY' 2>/dev/null
import sys, json
m=json.load(sys.stdin)
t=m.get("mediaType","")
if "image.index" in t or "manifest.list" in t:
    # choose linux/amd64
    for e in m.get("manifests",[]):
        p=e.get("platform") or {}
        if (p.get("os")=="linux" and p.get("architecture")=="amd64"):
            print("INDEX:"+e.get("digest",""))
            break
    else:
        # fallback first entry
        e=(m.get("manifests") or [{}])[0]
        print("INDEX:"+e.get("digest",""))
else:
    # schema2 manifest
    cfg=(m.get("config") or {})
    print("MANIFEST:"+cfg.get("digest",""))
PY
<<< "$MAN")"

case "$TYPE" in
  INDEX:*)
    DIG="\${TYPE#INDEX:}"
    [ -n "$DIG" ] || { echo ""; exit 0; }
    SUB_URL="https://ghcr.io/v2/versa-node/\${REPO}/manifests/\${DIG}"
    SUB="$(fetch "$SUB_URL")" || { echo ""; exit 0; }
    CFG_DIG="$(python3 - <<'PY' 2>/dev/null
import sys, json
m=json.load(sys.stdin)
print((m.get("config") or {}).get("digest",""))
PY
<<< "$SUB")"
    ;;
  MANIFEST:*)
    CFG_DIG="\${TYPE#MANIFEST:}"
    ;;
  *)
    echo ""; exit 0;;
esac

[ -n "$CFG_DIG" ] || { echo ""; exit 0; }

# 3) Fetch config blob and extract label
CFG_URL="https://ghcr.io/v2/versa-node/\${REPO}/blobs/\${CFG_DIG}"
CFG="$(fetch "$CFG_URL")" || { echo ""; exit 0; }

python3 - <<'PY' 2>/dev/null
import sys, json
cfg=json.load(sys.stdin)
labels=(cfg.get("config") or {}).get("Labels") or {}
print((labels.get("org.opencontainers.image.description","") or "").strip())
PY
<<< "$CFG"
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const desc = (out || "").trim();
    console.debug("[GHCR] OCI description for", `${fullName}:${tag}`, "=>", desc ? desc.substring(0, 80) + (desc.length > 80 ? "…" : "") : "<empty>");
    return desc;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrOciDescriptionViaSpawn failed:", e?.message || e);
    return "";
  }
}

export const ImageSearchModal = ({ downloadImage }) => {
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [searchFinished, setSearchFinished] = useState(false);
  const [imageIdentifier, setImageIdentifier] = useState('');
  const [imageList, setImageList] = useState([]);
  const [selectedRegistry, setSelectedRegistry] = useState("ghcr.io"); // default to ghcr
  const [selected, setSelected] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogErrorDetail, setDialogErrorDetail] = useState("");
  const [typingTimeout, setTypingTimeout] = useState(null);
  const [ghcrOrgListing, setGhcrOrgListing] = useState(false); // show results even with empty input

  // Tag handling
  const [tagOptions, setTagOptions] = useState([]);
  const [tagLoading, setTagLoading] = useState(false);
  const [tagError, setTagError] = useState("");
  const [selectedTag, setSelectedTag] = useState("latest");
  const [customTag, setCustomTag] = useState("");

  const activeConnectionRef = useRef(null);

  const { registries } = useDockerInfo();
  const Dialogs = useDialogs();

  // Registries to use for searching; ensure ghcr.io is present
  const baseRegistries =
    (registries?.search && registries.search.length !== 0)
      ? registries.search
      : fallbackRegistries;

  const mergedRegistries = Array.from(new Set(["ghcr.io", ...(baseRegistries || [])]));

  const closeActiveConnection = () => {
    if (activeConnectionRef.current) {
      try { activeConnectionRef.current.close(); } catch (_e) {}
      activeConnectionRef.current = null;
    }
  };

  // On first open, list org packages if ghcr selected and empty query
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If switching to ghcr with empty query, list org packages
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRegistry]);

  // If clearing query while on ghcr, re-list org packages
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIdentifier]);

  // Whenever selection changes, fetch tags + label description for GHCR images
  useEffect(() => {
    const idx = (selected || "") === "" ? -1 : parseInt(selected, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= imageList.length) return;
    const img = imageList[idx];
    if (!img?.name) return;

    const isVersaNodeGhcr = /^ghcr\.io\/versa-node\//i.test(img.name);

    // Reset tag UI
    setTagOptions([]);
    setSelectedTag("latest");
    setCustomTag("");
    setTagError("");

    console.debug("[UI] Selected index:", idx, "image:", img.name);

    if (isVersaNodeGhcr) {
      // Fetch tags
      (async () => {
        setTagLoading(true);
        try {
          const tags = await fetchGhcrTagsViaSpawn(img.name);
          setTagOptions(tags);
          if (tags.length > 0) {
            setSelectedTag(tags.includes("latest") ? "latest" : tags[0]);
          }
        } catch (e) {
          setTagOptions([]);
          setTagError(e?.message || String(e));
        } finally {
          setTagLoading(false);
        }
      })();

      // Fetch description label for the chosen/default tag and update that row
      (async () => {
        const tag = selectedTag || "latest";
        const desc = await fetchGhcrOciDescriptionViaSpawn(img.name, tag);
        if (desc) {
          setImageList((prev) => {
            const next = [...prev];
            if (next[idx] && next[idx].name === img.name) {
              next[idx] = { ...next[idx], description: desc };
            }
            return next;
          });
        } else if (!img.description) {
          // fallback placeholder so UI isn't blank
          setImageList((prev) => {
            const next = [...prev];
            if (next[idx] && next[idx].name === img.name && !next[idx].description) {
              next[idx] = { ...next[idx], description: "" };
            }
            return next;
          });
        }
      })();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // If the selected tag changes (and an item is selected), refresh the description to that tag
  useEffect(() => {
    const idx = (selected || "") === "" ? -1 : parseInt(selected, 10);
    if (Number.isNaN(idx) || idx < 0 || idx >= imageList.length) return;
    const img = imageList[idx];
    if (!img?.name) return;
    const isVersaNodeGhcr = /^ghcr\.io\/versa-node\//i.test(img.name);
    if (!isVersaNodeGhcr) return;

    (async () => {
      const tag = selectedTag || "latest";
      console.debug("[UI] Tag changed for", img.name, "->", tag);
      const desc = await fetchGhcrOciDescriptionViaSpawn(img.name, tag);
      if (desc) {
        setImageList((prev) => {
          const next = [...prev];
          if (next[idx] && next[idx].name === img.name) {
            next[idx] = { ...next[idx], description: desc };
          }
          return next;
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTag]);

  // Enrich a GHCR org listing with label descriptions (latest) progressively
  async function enrichListWithOciDescriptions(list) {
    const out = [...list];
    for (let i = 0; i < out.length; i++) {
      const row = out[i];
      if (/^ghcr\.io\/versa-node\//i.test(row.name)) {
        try {
          const desc = await fetchGhcrOciDescriptionViaSpawn(row.name, "latest");
          if (desc) {
            out[i] = { ...row, description: desc };
            // Update UI incrementally so user sees descriptions fill in
            setImageList((prev) => {
              const next = [...prev];
              if (next[i] && next[i].name === row.name) {
                next[i] = { ...next[i], description: desc };
              }
              return next;
            });
            console.debug("[GHCR] Enriched", row.name, "with description");
          }
        } catch (e) {
          console.warn("[GHCR] Enrich failed for", row.name, e?.message || e);
        }
      }
    }
    return out;
  }

  const onSearchTriggered = async (searchRegistry = "", forceSearch = false) => {
    setSearchFinished(false);

    const targetGhcr = isGhcr(searchRegistry) || isGhcrVersaNodeTerm(imageIdentifier);
    const typedRepo = imageIdentifier
      .replace(/^ghcr\.io\/?versa-node\/?/i, "")
      .replace(/^versa-node\/?/i, "")
      .trim();

    console.debug("[UI] Search triggered:", { searchRegistry, targetGhcr, typedRepo, forceSearch, imageIdentifier });

    // If GHCR targeted and no specific repo typed yet, try listing org packages (no error if not permitted)
    if (targetGhcr && typedRepo.length === 0) {
      setDialogError(""); setDialogErrorDetail("");
      setSearchInProgress(true);
      setGhcrOrgListing(true);
      try {
        const pkgs = await fetchGhcrOrgPackagesViaSpawn();
        // Seed with placeholder if empty to avoid totally blank column
        const seeded = pkgs.map(p => ({
          ...p,
          description: p.description || PLACEHOLDER_DESC,
        }));
        setImageList(seeded);
        setSelected(seeded.length ? "0" : "");
        // Enrich with image label descriptions (latest), progressively
        enrichListWithOciDescriptions(seeded).catch(() => {});
      } finally {
        setSearchInProgress(false);
        setSearchFinished(true);
      }
      closeActiveConnection();
      return;
    }

    // If user typed a specific versa-node repo, synthesize the full name (no /images/search on GHCR)
    if (targetGhcr) {
      const fullName = buildGhcrVersaNodeName(imageIdentifier);
      const bareNamespace = GHCR_NAMESPACE.replace(/\/+$/, "");
      if (!fullName || fullName === bareNamespace) {
        setImageList([]);
        setSelected("");
      } else {
        // Start with placeholder, then enrich from OCI label
        const row = { name: fullName, description: PLACEHOLDER_DESC };
        setImageList([row]);
        setSelected("0");
        fetchGhcrOciDescriptionViaSpawn(fullName, "latest")
          .then(desc => {
            setImageList([{ name: fullName, description: desc || "" }]);
          })
          .catch(() => {});
      }
      setGhcrOrgListing(false);
      setSearchInProgress(false);
      setSearchFinished(true);
      closeActiveConnection();
      return;
    }

    // Docker Hub (or registries that support /images/search)
    if (imageIdentifier.length < 2 && !forceSearch) {
      setGhcrOrgListing(false);
      return;
    }

    setSearchInProgress(true);
    setDialogError(""); setDialogErrorDetail("");
    setGhcrOrgListing(false);

    closeActiveConnection();
    activeConnectionRef.current = rest.connect(client.getAddress());

    let queryRegistries = baseRegistries;
    if (searchRegistry !== "") {
      queryRegistries = [searchRegistry];
    }

    if (imageIdentifier.includes('/')) {
      queryRegistries = [""];
    }

    const searches = (queryRegistries || []).map(rr => {
      const registry = rr.length < 1 || rr[rr.length - 1] === "/" ? rr : rr + "/";
      return activeConnectionRef.current.call({
        method: "GET",
        path: client.VERSION + "/images/search",
        body: "",
        params: { term: registry + imageIdentifier }
      });
    });

    try {
      const reply = await Promise.allSettled(searches);
      if (reply) {
        let results = [];
        for (const result of reply) {
          if (result.status === "fulfilled") {
            const parsed = JSON.parse(result.value);
            results = results.concat(parsed);
          } else {
            setDialogError(_("Failed to search for new images"));
            setDialogErrorDetail(result.reason
              ? cockpit.format(_("Failed to search for images: $0"), result.reason.message)
              : _("Failed to search for images."));
          }
        }
        console.debug("[Search] results:", results.length);
        // Ensure description key exists so UI doesn't render undefined
        const normalized = (results || []).map(r => ({
          ...r,
          description: (r.description || r.Description || "").trim(),
        }));
        setImageList(normalized);
        setSelected(normalized.length ? "0" : "");
      }
    } catch (err) {
      console.error("[Search] error:", err?.message || err);
      setDialogError(_("Failed to search for new images"));
      setDialogErrorDetail(err?.message || String(err));
    } finally {
      setSearchInProgress(false);
      setSearchFinished(true);
    }
  };

  const onKeyDown = (e) => {
    if (e.key !== ' ') {
      const forceSearch = e.key === 'Enter';
      if (forceSearch) e.preventDefault();
      clearTimeout(typingTimeout);
      setTypingTimeout(setTimeout(() => onSearchTriggered(selectedRegistry, forceSearch), 250));
    }
  };

  const onDownloadClicked = () => {
    if (!imageList.length || selected === "") return;
    const selectedImageName = imageList[selected].name;
    closeActiveConnection();
    Dialogs.close();
    const tag = tagOptions.length > 0
      ? (selectedTag || "latest")
      : ((customTag || "").trim() || "latest");
    console.debug("[UI] Download clicked:", { image: selectedImageName, tag });
    downloadImage(selectedImageName, tag);
  };

  const handleClose = () => {
    closeActiveConnection();
    Dialogs.close();
  };

  // Tag picker UI: show a combobox (FormSelect) when we have tagOptions; else fallback to text input.
  const TagPicker = () => {
    if (tagLoading) {
      return (
        <FormGroup fieldId="image-search-tag" label={_("Tag")}>
          <TextInput
            id="image-search-tag"
            type="text"
            isDisabled
            value={_("Loading…")}
            aria-label="loading tags"
          />
        </FormGroup>
      );
    }
    if (tagOptions.length > 0) {
      return (
        <FormGroup fieldId="image-search-tag-select" label={_("Tag")}>
          <FormSelect
            id="image-search-tag-select"
            value={selectedTag}
            onChange={(_e, val) => {
              console.debug("[UI] Tag selected:", val);
              setSelectedTag(val);
            }}
          >
            {tagOptions.map(t => (
              <FormSelectOption key={t} value={t} label={t} />
            ))}
          </FormSelect>
        </FormGroup>
      );
    }
    // No tags available or non-GHCR registry: free text
    return (
      <FormGroup fieldId="image-search-tag-text" label={_("Tag")}>
        <TextInput
          className="image-tag-entry"
          id="image-search-tag-text"
          type="text"
          placeholder="latest"
          value={customTag}
          onChange={(_event, value) => setCustomTag(value)}
        />
        {tagError && (
          <div className="pf-v5-c-form__helper-text pf-m-error" aria-live="polite">
            {_("Could not list tags; enter one manually.")}
          </div>
        )}
      </FormGroup>
    );
  };

  return (
    <Modal
      isOpen
      className="docker-search"
      position="top"
      variant="large"
      onClose={handleClose}
      title={_("Search for an image")}
      footer={
        <>
          <Form isHorizontal className="image-search-tag-form">
            <TagPicker />
          </Form>
          <Button variant="primary" isDisabled={selected === ""} onClick={onDownloadClicked}>
            {_("Download")}
          </Button>
          <Button variant="link" className="btn-cancel" onClick={handleClose}>
            {_("Cancel")}
          </Button>
        </>
      }
    >
      <Form isHorizontal>
        {dialogError && <ErrorNotification errorMessage={dialogError} errorDetail={dialogErrorDetail} />}

        <Flex spaceItems={{ default: 'inlineFlex', modifier: 'spaceItemsXl' }}>
          <FormGroup fieldId="search-image-dialog-name" label={_("Search for")}>
            <TextInput
              id="search-image-dialog-name"
              type="text"
              placeholder={_("Type image (e.g. nginx) or versa-node/<repo>")}
              value={imageIdentifier}
              onKeyDown={onKeyDown}
              onChange={(_event, value) => setImageIdentifier(value)}
            />
          </FormGroup>
          <FormGroup fieldId="registry-select" label={_("in")}>
            <FormSelect
              id="registry-select"
              value={selectedRegistry}
              onChange={(_ev, value) => {
                console.debug("[UI] Registry changed:", value);
                setSelectedRegistry(value);
                clearTimeout(typingTimeout);
                onSearchTriggered(value, false);
              }}
            >
              {(mergedRegistries || []).map(r => (
                <FormSelectOption
                  value={r}
                  key={r}
                  label={r === "ghcr.io" ? "ghcr.io (versa-node)" : r}
                />
              ))}
            </FormSelect>
          </FormGroup>
        </Flex>
      </Form>

      {searchInProgress && <EmptyStatePanel loading title={_("Searching...")} /> }

      {!searchInProgress && !searchFinished && !ghcrOrgListing && imageIdentifier.trim() === "" && (
        <EmptyStatePanel
          title={_("No images found")}
          paragraph={_("Start typing to look for images, or choose ghcr.io to list org packages (if configured).")}
        />
      )}

      {searchFinished && (
        <>
          {imageList.length === 0 && (
            <EmptyStatePanel
              icon={ExclamationCircleIcon}
              title={cockpit.format(_("No results for $0"), imageIdentifier || "GHCR")}
              paragraph={_("Retry another term or switch registry.")}
            />
          )}
          {imageList.length > 0 && (
            <DataList
              isCompact
              selectedDataListItemId={"image-list-item-" + selected}
              onSelectDataListItem={(_, key) => {
                const idx = key.split('-').slice(-1)[0];
                setSelected(idx);
              }}
            >
              {imageList.map((image, iter) => (
                <DataListItem id={"image-list-item-" + iter} key={iter} className="image-list-item">
                  <DataListItemRow>
                    <DataListItemCells
                      dataListCells={[
                        <DataListCell key="primary content">
                          <span className="image-name">{image.name}</span>
                        </DataListCell>,
                        <DataListCell key="secondary content" wrapModifier="truncate">
                          <span className="image-description">
                            {image.description && image.description !== PLACEHOLDER_DESC
                              ? image.description
                              : (image.description === PLACEHOLDER_DESC ? PLACEHOLDER_DESC : "")}
                          </span>
                        </DataListCell>
                      ]}
                    />
                  </DataListItemRow>
                </DataListItem>
              ))}
            </DataList>
          )}
        </>
      )}
    </Modal>
  );
};
