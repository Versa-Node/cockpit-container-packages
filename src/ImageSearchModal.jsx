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
HDR_UA="User-Agent: versanode-cockpit/1.0"
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
RESP="$(curl -fsSL -H "$HDR_ACCEPT" -H "$HDR_API" -H "$HDR_UA" -H "Authorization: Bearer $TOKEN" "$URL")"
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
    // Initial description from GH package metadata (will be enriched by OCI label later)
    return (pkgs || []).map(p => ({
      name: `ghcr.io/versa-node/${p.name}`,
      description: p.description || "",
    }));
  } catch (_e) {
    return [];
  }
}

// Fetch tags from GHCR Registry V2 API
async function fetchGhcrTagsViaSpawn(fullName) {
  const repo = parseGhcrRepoName(fullName);
  if (!repo) return [];

  const script = `
set -euo pipefail
REPO="${repo}"
BASE="https://ghcr.io/v2/versa-node/${repo}/tags/list?n=200"
UA="User-Agent: versanode-cockpit/1.0"

try_no_auth() {
  curl -fsSL -H "$1" "$2" || return 1
}

try_with_auth() {
  local TOKEN_FILE="/etc/versanode/github.token"
  if [ ! -r "$TOKEN_FILE" ]; then
    return 1
  fi
  local T
  T="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
  [ -z "$T" ] && return 1
  curl -fsSL -H "$1" -H "Authorization: Bearer $T" "$2" || return 1
}

set +e
RESP="$(try_no_auth "$UA" "$BASE")"
EC=$?
set -e

if [ $EC -ne 0 ] || [ -z "$RESP" ]; then
  set +e
  RESP="$(try_with_auth "$UA" "$BASE")"
  EC=$?
  set -e
fi

if [ $EC -ne 0 ] || [ -z "$RESP" ]; then
  echo '{"tags":[]}'
else
  echo "$RESP"
fi
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const parsed = JSON.parse(out || '{"tags":[]}');
    const tags = Array.isArray(parsed.tags) ? parsed.tags : [];
    const uniq = Array.from(new Set(tags));
    // Prefer "latest" first, then semver-ish/numeric
    uniq.sort((a, b) => {
      if (a === 'latest') return -1;
      if (b === 'latest') return 1;
      return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
    });
    return uniq;
  } catch (_e) {
    return [];
  }
}

// Fetch org.opencontainers.image.description from the OCI/Docker config for a repo:tag
// Works on multi-arch (follows manifest index -> linux/amd64 manifest -> config blob).
async function fetchGhcrOciDescriptionViaSpawn(fullName, tagIn) {
  const repo = parseGhcrRepoName(fullName);
  let tag = (tagIn || "latest").trim();
  if (!repo) return "";
  // Keep only safe tag chars to avoid script injection
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) tag = "latest";

  const script = `
set -euo pipefail

REPO="${repo}"
TAG="${tag}"

UA="User-Agent: versanode-cockpit/1.0"
ACCEPT_ALL="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

token_header() {
  local TOKEN_FILE="/etc/versanode/github.token"
  if [ -r "$TOKEN_FILE" ]; then
    local T
    T="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
    if [ -n "$T" ]; then
      echo "-H Authorization: Bearer $T"
      return 0
    fi
  fi
  return 1
}

fetch() {
  # $1: URL
  local AUTH_ARGS=()
  if ! curl -fsSL -H "$UA" -H "$ACCEPT_ALL" "$1"; then
    if token_header >/dev/null; then
      local TH; TH="$(token_header)"
      # shellcheck disable=SC2086
      curl -fsSL -H "$UA" -H "$ACCEPT_ALL" $TH "$1" || return 1
    else
      return 1
    fi
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
print(labels.get("org.opencontainers.image.description",""))
PY
<<< "$CFG"
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    return (out || "").trim();
  } catch (_e) {
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

    // If GHCR targeted and no specific repo typed yet, try listing org packages (no error if not permitted)
    if (targetGhcr && typedRepo.length === 0) {
      setDialogError(""); setDialogErrorDetail("");
      setSearchInProgress(true);
      setGhcrOrgListing(true);
      try {
        const pkgs = await fetchGhcrOrgPackagesViaSpawn();
        setImageList(pkgs);
        setSelected(pkgs.length ? "0" : "");
        // Enrich with image label descriptions (latest), progressively
        enrichListWithOciDescriptions(pkgs).catch(() => {});
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
        // Start with generic, then enrich from OCI label
        const row = { name: fullName, description: "" };
        setImageList([row]);
        setSelected("0");
        // Try to get label from 'latest' immediately
        fetchGhcrOciDescriptionViaSpawn(fullName, "latest").then(desc => {
          if (desc) setImageList([{ name: fullName, description: desc }]);
        }).catch(() => {});
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
            results = results.concat(JSON.parse(result.value));
          } else {
            setDialogError(_("Failed to search for new images"));
            setDialogErrorDetail(result.reason
              ? cockpit.format(_("Failed to search for images: $0"), result.reason.message)
              : _("Failed to search for images."));
          }
        }
        setImageList(results || []);
        setSelected(results.length ? "0" : "");
      }
    } catch (err) {
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
            onChange={(_e, val) => setSelectedTag(val)}
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
              onSelectDataListItem={(_, key) => setSelected(key.split('-').slice(-1)[0])}
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
                          <span className="image-description">{image.description || ""}</span>
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
