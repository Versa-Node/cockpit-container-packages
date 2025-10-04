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
const isGhcrVersaNodeTerm = (term) =>
  /^ghcr\.io\/versa-node\/[^/]+/i.test(term || "") || /^versa-node\/[^/]+/i.test(term || "");
const buildGhcrVersaNodeName = (txt) => {
  const t = (txt || "").trim()
    .replace(/^ghcr\.io\/?/i, "")
    .replace(/^versa-node\/?/i, "");
  return (GHCR_NAMESPACE + t).replace(/\/+$/, "");
};
// strip "ghcr.io/" if present; return "versa-node/name"
const repoPathForToken = (fullName) =>
  (fullName || "").replace(/^ghcr\.io\//i, "").replace(/^\/+/, "");

// ---------- Server-side helpers via cockpit.spawn ----------
// Silent org list (falls back to [])
async function fetchGhcrOrgPackagesViaSpawn() {
  const script = `
set -euo pipefail
URL="https://api.github.com/orgs/${GH_ORG}/packages?package_type=container&per_page=100"
HDR_ACCEPT="Accept: application/vnd.github+json"
HDR_API="X-GitHub-Api-Version: 2022-11-28"
HDR_UA="User-Agent: versanode-cockpit/1.1"
TOKEN_FILE="/etc/versanode/github.token"

if [ -r "$TOKEN_FILE" ] && [ -s "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
  AUTH="-H Authorization: Bearer ${TOKEN}"
else
  AUTH=""
fi

set +e
RESP="$(curl -fsSL -H "$HDR_ACCEPT" -H "$HDR_API" -H "$HDR_UA" $AUTH "$URL")"
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
    return (pkgs || []).map(p => ({
      name: `ghcr.io/versa-node/${p.name}`,
      description: p.description || "GitHub Container Registry (versa-node)",
    }));
  } catch (_e) {
    return [];
  }
}

// Fetch available tags for a GHCR repo (public works anonymously)
async function fetchGhcrTagsViaSpawn(fullName) {
  const repo = repoPathForToken(fullName); // "versa-node/<name>"
  const script = `
set -euo pipefail
repo="${repo}"
# Get a registry token (anonymous works for public)
TOK_JSON="$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull")"
TOKEN="$(python3 - <<'PY'
import sys, json
print(json.load(sys.stdin).get("token",""))
PY
<<< "$TOK_JSON")"
test -n "$TOKEN" || { echo "[]"; exit 0; }

TAGS_JSON="$(curl -fsSL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/${repo}/tags/list?n=1000")"
python3 - <<'PY' <<< "$TAGS_JSON"
import sys, json
print(json.dumps((json.load(sys.stdin) or {}).get("tags", []) or []))
PY
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "try", err: "message" });
    return JSON.parse(out || "[]");
  } catch (_e) {
    return [];
  }
}

// Fetch OCI label org.opencontainers.image.description for repo:tag
async function fetchGhcrOciDescriptionViaSpawn(fullName, tag="latest") {
  const repo = repoPathForToken(fullName); // "versa-node/<name>"
  const escTag = (tag || "latest").trim() || "latest";
  const script = `
set -euo pipefail
repo="${repo}"
ref_tag="${escTag}"
# Acquire token (anon for public)
TOK_JSON="$(curl -fsSL "https://ghcr.io/token?service=ghcr.io&scope=repository:${repo}:pull")"
TOKEN="$(python3 - <<'PY'
import sys, json
print(json.load(sys.stdin).get("token",""))
PY
<<< "$TOK_JSON")"
test -n "$TOKEN" || { echo ""; exit 0; }

# Accept both list and single-manifest
ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json"
MAN="$(curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: $ACCEPT" "https://ghcr.io/v2/${repo}/manifests/${ref_tag}")" || { echo ""; exit 0; }

python3 - <<'PY' <<EOF
import sys, json, urllib.request
import base64

repo = "${repo}"
token = "${TOKEN}"
man = json.loads("""${MAN}""")

def http_get(url, accept=None):
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    if accept:
        req.add_header("Accept", accept)
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()

def cfg_from_digest(digest):
    # Pull config blob and parse labels
    cfg = json.loads(http_get(f"https://ghcr.io/v2/{repo}/blobs/{digest}"))
    labels = (cfg.get("config") or {}).get("Labels") or {}
    print(labels.get("org.opencontainers.image.description",""))
    sys.exit(0)

# OCI index or Docker manifest list
if "manifests" in man:
    # prefer amd64, else arm64, else first
    prefer = ["amd64", "arm64"]
    chosen = None
    for arch in prefer:
        for m in man["manifests"]:
            plat = (m.get("platform") or {})
            if plat.get("architecture") == arch:
                chosen = m
                break
        if chosen:
            break
    if not chosen:
        chosen = (man["manifests"] or [None])[0]
    if not chosen:
        print("")
        sys.exit(0)
    # fetch single-manifest to get config digest
    acc = "application/vnd.docker.distribution.manifest.v2+json"
    sm = json.loads(http_get(f"https://ghcr.io/v2/{repo}/manifests/{chosen['digest']}", acc))
    cfg = (sm.get("config") or {}).get("digest")
    if not cfg:
        print("")
        sys.exit(0)
    cfg_from_digest(cfg)
else:
    # single-manifest already; read config
    cfg = (man.get("config") or {}).get("digest")
    if not cfg:
        print("")
        sys.exit(0)
    cfg_from_digest(cfg)
PY
EOF
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "try", err: "message" });
    return (out || "").trim();
  } catch (_e) {
    return "";
  }
}

export const ImageSearchModal = ({ downloadImage }) => {
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [searchFinished, setSearchFinished] = useState(false);
  const [imageIdentifier, setImageIdentifier] = useState('');
  const [imageList, setImageList] = useState([]); // [{name, description}]
  const [tags, setTags] = useState([]);           // tags for the currently selected GHCR image
  const [imageTag, setImageTag] = useState("latest");
  const [selectedRegistry, setSelectedRegistry] = useState("ghcr.io");
  const [selected, setSelected] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogErrorDetail, setDialogErrorDetail] = useState("");
  const [typingTimeout, setTypingTimeout] = useState(null);
  const [ghcrOrgListing, setGhcrOrgListing] = useState(false);

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

  // Enrich a GHCR image item with OCI description (latest)
  const enrichOneWithOciDescription = async (item) => {
    const desc = await fetchGhcrOciDescriptionViaSpawn(item.name, "latest");
    if (desc) {
      setImageList(prev =>
        prev.map(x => x.name === item.name ? { ...x, description: desc } : x)
      );
    }
  };

  // For ghcr org list: fetch descriptions in background (don’t block UI)
  const enrichAllGhcr = async (items) => {
    items.forEach(it => { void enrichOneWithOciDescription(it); });
  };

  // When user selects a GHCR image row, fetch its tags (combobox) and tighten description to selected tag
  const onRowSelected = async (idx) => {
    setSelected(idx);
    const item = imageList[idx];
    if (!item) return;

    if (isGhcrVersaNodeTerm(item.name)) {
      // load tags
      const t = await fetchGhcrTagsViaSpawn(item.name);
      setTags(t || []);
      // prefer latest if available
      if (t && t.length) {
        const prefer = t.includes("latest") ? "latest" : t[0];
        setImageTag(prefer);
        // update description for that tag (if available)
        const d = await fetchGhcrOciDescriptionViaSpawn(item.name, prefer);
        if (d) {
          setImageList(prev =>
            prev.map(x => x.name === item.name ? { ...x, description: d } : x)
          );
        }
      } else {
        setTags([]);
      }
    } else {
      setTags([]);
    }
  };

  // Trigger a fetch on first open if ghcr is selected and the box is empty
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  // If user switches to ghcr.io and the query is empty, list org packages
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRegistry]);

  // Also, if the user clears the input while on ghcr, re-list the org
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIdentifier]);

  const onSearchTriggered = async (searchRegistry = "", forceSearch = false) => {
    setSearchFinished(false);
    setDialogError(""); setDialogErrorDetail("");

    const targetGhcr = isGhcr(searchRegistry) || isGhcrVersaNodeTerm(imageIdentifier);
    const typedRepo = imageIdentifier
      .replace(/^ghcr\.io\/?versa-node\/?/i, "")
      .replace(/^versa-node\/?/i, "")
      .trim();

    // GHCR org listing
    if (targetGhcr && typedRepo.length === 0) {
      setSearchInProgress(true);
      setGhcrOrgListing(true);
      const pkgs = await fetchGhcrOrgPackagesViaSpawn();
      setImageList(pkgs);
      setSelected(pkgs.length ? "0" : "");
      setTags([]);
      setImageTag("latest");
      setSearchInProgress(false);
      setSearchFinished(true);
      // Enrich with OCI descriptions (latest) in background
      void enrichAllGhcr(pkgs);
      closeActiveConnection();
      return;
    }

    // GHCR direct: user typed repo
    if (targetGhcr) {
      const fullName = buildGhcrVersaNodeName(imageIdentifier);
      const bareNamespace = GHCR_NAMESPACE.replace(/\/+$/, "");
      if (!fullName || fullName === bareNamespace) {
        setImageList([]); setSelected(""); setTags([]); setImageTag("latest");
      } else {
        const baseItem = { name: fullName, description: _("GitHub Container Registry (versa-node)") };
        setImageList([baseItem]);
        setSelected("0");
        // load tags & description for latest
        const t = await fetchGhcrTagsViaSpawn(fullName);
        setTags(t || []);
        const prefer = (t && t.length) ? (t.includes("latest") ? "latest" : t[0]) : "latest";
        setImageTag(prefer);
        const desc = await fetchGhcrOciDescriptionViaSpawn(fullName, prefer);
        if (desc) setImageList([{ ...baseItem, description: desc }]);
      }
      setGhcrOrgListing(false);
      setSearchInProgress(false);
      setSearchFinished(true);
      closeActiveConnection();
      return;
    }

    // Docker Hub / others (use /images/search via Docker API)
    if (imageIdentifier.length < 2 && !forceSearch) {
      setGhcrOrgListing(false);
      return;
    }

    setSearchInProgress(true);
    setGhcrOrgListing(false);

    closeActiveConnection();
    activeConnectionRef.current = rest.connect(client.getAddress());

    let queryRegistries = baseRegistries;
    if (searchRegistry !== "") queryRegistries = [searchRegistry];
    if (imageIdentifier.includes('/')) queryRegistries = [""];

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
      let results = [];
      for (const r of reply) {
        if (r.status === "fulfilled") {
          results = results.concat(JSON.parse(r.value));
        } else if (!dialogError) {
          setDialogError(_("Failed to search for new images"));
          setDialogErrorDetail(r.reason
            ? cockpit.format(_("Failed to search for images: $0"), r.reason.message)
            : _("Failed to search for images."));
        }
      }
      // Normalize to [{name, description}]
      const norm = (results || []).map(it => ({
        name: it?.Name || "",
        description: it?.Description || ""
      }));
      setImageList(norm);
      setSelected(norm.length ? "0" : "");
      setTags([]);
      setImageTag("latest");
    } catch (err) {
      setDialogError(_("Failed to search for new images"));
      setDialogErrorDetail(err?.message || String(err));
      setImageList([]);
      setSelected("");
      setTags([]);
      setImageTag("latest");
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
    const tag = (imageTag || "").trim() || "latest";
    downloadImage(selectedImageName, tag);
  };

  const handleClose = () => {
    closeActiveConnection();
    Dialogs.close();
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
            <FormGroup fieldId="image-search-tag" label={_("Tag")}>
              {tags && tags.length > 0 ? (
                <FormSelect
                  id="image-search-tag"
                  value={imageTag}
                  onChange={(_ev, value) => setImageTag(value)}
                >
                  {tags.map(t => (
                    <FormSelectOption value={t} key={t} label={t} />
                  ))}
                </FormSelect>
              ) : (
                <TextInput
                  className="image-tag-entry"
                  id="image-search-tag"
                  type="text"
                  placeholder="latest"
                  value={imageTag}
                  onChange={(_event, value) => setImageTag(value)}
                />
              )}
            </FormGroup>
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
              onSelectDataListItem={(_, key) => onRowSelected(key.split('-').slice(-1)[0])}
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
                          <span className="image-description">{image.description}</span>
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
