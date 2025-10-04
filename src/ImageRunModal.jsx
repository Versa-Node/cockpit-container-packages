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

// -------------------- ORG LIST (GitHub Packages REST) --------------------
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
  # anonymous is fine for public org package list
  set +e
  RESP="$(curl -fsSL -H "$HDR_ACCEPT" -H "$HDR_API" -H "$UA" "$URL")"
  EC=$?
  set -e
  if [ $EC -ne 0 ] || [ -z "$RESP" ]; then echo "[]"; else echo "$RESP"; fi
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
    // Start with GitHub Package description if present
    return (pkgs || []).map(p => ({
      name: `ghcr.io/versa-node/${p.name}`,
      description: (p.description || "").trim(),
    }));
  } catch (e) {
    console.warn("[GHCR] fetchGhcrOrgPackagesViaSpawn failed:", e?.message || e);
    return [];
  }
}

// -------------------- TOKEN (Registry v2) --------------------
async function ghcrGetRegistryTokenViaSpawn(repo) {
  const script = `
set -euo pipefail

REPO="${repo}"
SCOPE="repository:versa-node/\${REPO}:pull"
BASE_URL="https://ghcr.io/token?service=ghcr.io&scope=\${SCOPE}"
UA="User-Agent: versanode-cockpit/1.0"

try_anon() {
  curl -fsSL -H "$UA" "$BASE_URL" 2>/dev/null || return 1
}

try_basic() {
  # $1=username  $2=pat
  local AUTH
  AUTH="$(printf '%s:%s' "$1" "$2" | base64 -w0 2>/dev/null || printf '%s:%s' "$1" "$2" | base64)"
  curl -fsSL -H "$UA" -H "Authorization: Basic $AUTH" "$BASE_URL" 2>/dev/null || return 1
}

TOKEN_FILE="/etc/versanode/github.token"
USER_FILE="/etc/versanode/github.user"

# 1) anonymous (works if package public)
set +e
RESP="$(try_anon)"
EC=$?
set -e
if [ $EC -eq 0 ] && [ -n "$RESP" ]; then
  echo "$RESP"
  exit 0
fi

# 2) PAT available?
if [ ! -r "$TOKEN_FILE" ]; then
  echo ""
  exit 0
fi
PAT="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
if [ -z "$PAT" ]; then
  echo ""
  exit 0
fi

# username?
USER=""
if [ -r "$USER_FILE" ]; then
  USER="$(tr -d '\\r\\n' < "$USER_FILE")"
fi

# 2a) If we have an explicit username, use it
if [ -n "$USER" ]; then
  set +e
  RESP="$(try_basic "$USER" "$PAT")"
  EC=$?
  set -e
  if [ $EC -eq 0 ] && [ -n "$RESP" ]; then
    echo "$RESP"
    exit 0
  fi
fi

# 2b) Fallback usernames some registries accept
for U in "oauth2" "token" ""; do
  set +e
  RESP="$(try_basic "$U" "$PAT")"
  EC=$?
  set -e
  if [ $EC -eq 0 ] && [ -n "$RESP" ]; then
    echo "$RESP"
    exit 0
  fi
done

echo ""
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    if (!out) {
      console.debug("[GHCR] token: none (anonymous + PAT exchange failed)");
      return "";
    }
    const token = (JSON.parse(out).token || "").trim();
    console.debug("[GHCR] token acquired for", repo, "?", Boolean(token));
    return token;
  } catch (e) {
    console.warn("[GHCR] ghcrGetRegistryTokenViaSpawn failed:", e?.message || e);
    return "";
  }
}

// -------------------- TAGS (Registry v2) --------------------
async function fetchGhcrTagsViaSpawn(fullName) {
  const repo = parseGhcrRepoName(fullName);
  if (!repo) return [];
  console.debug("[GHCR] fetching tags for", repo);

  const token = await ghcrGetRegistryTokenViaSpawn(repo);

  const script = `
set -euo pipefail
REPO="${repo}"
UA="User-Agent: versanode-cockpit/1.0"
URL="https://ghcr.io/v2/versa-node/\${REPO}/tags/list?n=200"

if [ -n "${token}" ]; then
  curl -fsSL -H "$UA" -H "Accept: application/json" -H "Docker-Distribution-API-Version: registry/2.0" -H "Authorization: Bearer ${token}" "$URL"
else
  curl -fsSL -H "$UA" -H "Accept: application/json" -H "Docker-Distribution-API-Version: registry/2.0" "$URL"
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
    console.debug("[GHCR] tags:", repo, "=>", uniq.slice(0, 10), uniq.length > 10 ? `(+${uniq.length - 10})` : "");
    return uniq;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrTagsViaSpawn failed:", e?.message || e);
    return [];
  }
}

// -------------------- DESCRIPTION (Registry v2 label) --------------------
async function fetchGhcrOciDescriptionViaSpawn(fullName, tagIn) {
  const repo = parseGhcrRepoName(fullName);
  let tag = (tagIn || "latest").trim();
  if (!repo) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) tag = "latest";

  const token = await ghcrGetRegistryTokenViaSpawn(repo);
  if (!token) {
    console.debug("[GHCR] no token for", repo, "— attempting anonymous fetch");
  }

  const script = `
set -euo pipefail

REPO="${repo}"
TAG="${tag}"

UA="User-Agent: versanode-cockpit/1.0"
ACCEPT_ALL="Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

fetch() {
  # $1: URL
  if [ -n "${token}" ]; then
    curl -fsSL -H "$UA" -H "$ACCEPT_ALL" -H "Docker-Distribution-API-Version: registry/2.0" -H "Authorization: Bearer ${token}" "$1"
  else
    curl -fsSL -H "$UA" -H "$ACCEPT_ALL" -H "Docker-Distribution-API-Version: registry/2.0" "$1"
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
    for e in m.get("manifests",[]):
        p=e.get("platform") or {}
        if (p.get("os")=="linux" and p.get("architecture")=="amd64"):
            print("INDEX:"+e.get("digest",""))
            break
    else:
        e=(m.get("manifests") or [{}])[0]
        print("INDEX:"+e.get("digest",""))
else:
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
    console.debug("[GHCR] label description", `${repo}:${tag}`, "=>", desc ? desc.substring(0, 80) + (desc.length > 80 ? "…" : "") : "<empty>");
    return desc;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrOciDescriptionViaSpawn failed:", e?.message || e);
    return "";
  }
}

// -------------------- FALLBACK: parse Dockerfile in GitHub repo --------------------
// No auth needed; reads the Dockerfile on main branch and extracts
//   org.opencontainers.image.description
async function fetchDescriptionFromRepoDockerfileViaSpawn(repo) {
  const safe = (repo || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe) return "";
  const script = `
set -euo pipefail
UA="User-Agent: versanode-cockpit/1.0"
RAW="https://raw.githubusercontent.com/Versa-Node/container-packages/main/packages/${safe}/Dockerfile"

set +e
BODY="$(curl -fsSL -H "$UA" "$RAW")"
EC=$?
set -e
if [ $EC -ne 0 ] || [ -z "$BODY" ]; then
  echo ""
  exit 0
fi

python3 - <<'PY' 2>/dev/null
import sys, re
text=sys.stdin.read()

# try both LABEL k=v and LABEL "k"="v" styles, single or double quotes
patterns = [
  r'org\\.opencontainers\\.image\\.description\\s*=\\s*"([^"]*)"',
  r'org\\.opencontainers\\.image\\.description\\s*=\\s*\\\'([^\\\']*)\\\'',
  r'"org\\.opencontainers\\.image\\.description"\\s*=\\s*"([^"]*)"',
  r"['\\\"]org\\.opencontainers\\.image\\.description['\\\"]\\s*=\\s*['\\\"]([^'\\\"]*)['\\\"]",
]
for pat in patterns:
    m=re.search(pat, text)
    if m:
        print((m.group(1) or '').strip())
        break
else:
    print('')
PY
<<< "$BODY"
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const desc = (out || "").trim();
    console.debug("[GH] fallback Dockerfile description", safe, "=>", desc ? desc : "<empty>");
    return desc;
  } catch (e) {
    console.warn("[GH] fetchDescriptionFromRepoDockerfileViaSpawn failed:", e?.message || e);
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

  // Whenever selection changes, fetch tags + description for GHCR images
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

      // Fetch description label (registry) → fall back to parsing Dockerfile if needed
      (async () => {
        const tag = selectedTag || "latest";
        let desc = await fetchGhcrOciDescriptionViaSpawn(img.name, tag);
        if (!desc) {
          const repo = parseGhcrRepoName(img.name);
          desc = await fetchDescriptionFromRepoDockerfileViaSpawn(repo);
        }
        if (desc) {
          setImageList((prev) => {
            const next = [...prev];
            if (next[idx] && next[idx].name === img.name) {
              next[idx] = { ...next[idx], description: desc };
            }
            return next;
          });
        } else {
          console.debug("[Desc] no description resolved for", img.name);
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
      let desc = await fetchGhcrOciDescriptionViaSpawn(img.name, tag);
      if (!desc) {
        const repo = parseGhcrRepoName(img.name);
        desc = await fetchDescriptionFromRepoDockerfileViaSpawn(repo);
      }
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
  async function enrichListWithDescriptions(list) {
    const out = [...list];
    for (let i = 0; i < out.length; i++) {
      const row = out[i];
      if (/^ghcr\.io\/versa-node\//i.test(row.name)) {
        try {
          let desc = await fetchGhcrOciDescriptionViaSpawn(row.name, "latest");
          if (!desc) {
            const repo = parseGhcrRepoName(row.name);
            desc = await fetchDescriptionFromRepoDockerfileViaSpawn(repo);
          }
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
            console.debug("[Desc] enriched", row.name);
          }
        } catch (e) {
          console.warn("[Desc] enrich failed for", row.name, e?.message || e);
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

    // If GHCR targeted and no specific repo typed yet, try listing org packages
    if (targetGhcr && typedRepo.length === 0) {
      setDialogError(""); setDialogErrorDetail("");
      setSearchInProgress(true);
      setGhcrOrgListing(true);
      try {
        const pkgs = await fetchGhcrOrgPackagesViaSpawn();
        setImageList(pkgs);
        setSelected(pkgs.length ? "0" : "");
        // Enrich with descriptions progressively (registry label → repo Dockerfile fallback)
        enrichListWithDescriptions(pkgs).catch(() => {});
      } finally {
        setSearchInProgress(false);
        setSearchFinished(true);
      }
      closeActiveConnection();
      return;
    }

    // If user typed a specific versa-node repo, synthesize the full name
    if (targetGhcr) {
      const fullName = buildGhcrVersaNodeName(imageIdentifier);
      const bareNamespace = GHCR_NAMESPACE.replace(/\/+$/, "");
      if (!fullName || fullName === bareNamespace) {
        setImageList([]);
        setSelected("");
      } else {
        const row = { name: fullName, description: "" };
        setImageList([row]);
        setSelected("0");
        // Try to get label, then fallback to Dockerfile
        (async () => {
          let desc = await fetchGhcrOciDescriptionViaSpawn(fullName, "latest");
          if (!desc) {
            const repo = parseGhcrRepoName(fullName);
            desc = await fetchDescriptionFromRepoDockerfileViaSpawn(repo);
          }
          if (desc) setImageList([{ name: fullName, description: desc }]);
        })().catch(() => {});
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
        // Normalize description key (some registries use Description)
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

  // Tag picker UI
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
                            {image.description || ""}
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
