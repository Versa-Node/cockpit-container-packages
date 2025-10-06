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
const GH_ORG = "versa-node";             // org is case-insensitive in API paths
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

// -------------------- SIMPLE IN-MEMORY CACHES --------------------
// (module-level -> persists across component mounts in the same session)
const ghcrOrgCache = { list: null, at: 0 }; // {list: [{name, description}], at: ts}
const descCache = new Map(); // key: `${name}@${tag}` -> description
const tagsCache = new Map(); // key: repo -> [tags]
const tokenCache = new Map(); // key: repo -> token (string)

// cache helpers
const now = () => Date.now();
const MIN = 60 * 1000;
const isFresh = (ts, maxAgeMs) => ts && (now() - ts) < maxAgeMs;

// -------------------- ORG LIST (GitHub Packages REST) --------------------
// If token file is missing or not permitted, return an empty list silently.
async function fetchGhcrOrgPackagesViaSpawn({ bypassCache = false } = {}) {
  if (!bypassCache && ghcrOrgCache.list && isFresh(ghcrOrgCache.at, 10 * MIN)) {
    return ghcrOrgCache.list;
  }

  const script = `
set -euo pipefail
URL="https://api.github.com/orgs/${GH_ORG}/packages?package_type=container&per_page=100"
HDR_ACCEPT="Accept: application/vnd.github+json"
HDR_API="X-GitHub-Api-Version: 2022-11-28"
UA="User-Agent: versanode-cockpit/1.0"
TOKEN_FILE="/etc/versanode/github.token"

try_curl() {
  if [ -n "$1" ]; then
    curl -fsSL -H "$HDR_ACCEPT" -H "$HDR_API" -H "$UA" -H "Authorization: Bearer $1" "$URL"
  else
    curl -fsSL -H "$HDR_ACCEPT" -H "$HDR_API" -H "$UA" "$URL"
  fi
}

TOKEN=""
if [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
fi

set +e
RESP="$(try_curl "$TOKEN")"
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
    const normalized = (pkgs || []).map(p => ({
      name: `ghcr.io/versa-node/${p.name}`,
      description: (p.description || "").trim(),  // fallback (GitHub package description)
    }));
    ghcrOrgCache.list = normalized;
    ghcrOrgCache.at = now();
    console.debug("[GHCR] Org packages fetched:", normalized.length);
    return normalized;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrOrgPackagesViaSpawn failed:", e?.message || e);
    return [];
  }
}

// -------------------- TOKEN (Registry v2) --------------------
async function ghcrGetRegistryTokenViaSpawn(repo, { bypassCache = false } = {}) {
  if (!bypassCache && tokenCache.has(repo)) return tokenCache.get(repo) || "";

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

# 1) anonymous (public packages)
set +e
RESP="$(try_anon)"
EC=$?
set -e
if [ $EC -eq 0 ] && [ -n "$RESP" ]; then
  echo "$RESP"; exit 0
fi

# 2) PAT?
if [ ! -r "$TOKEN_FILE" ]; then
  echo ""; exit 0
fi
PAT="$(tr -d '\\r\\n' < "$TOKEN_FILE")"
[ -z "$PAT" ] && { echo ""; exit 0; }

USER=""
if [ -r "$USER_FILE" ]; then USER="$(tr -d '\\r\\n' < "$USER_FILE")"; fi

if [ -n "$USER" ]; then
  set +e; RESP="$(try_basic "$USER" "$PAT")"; EC=$?; set -e
  if [ $EC -eq 0 ] && [ -n "$RESP" ]; then echo "$RESP"; exit 0; fi
fi

for U in "oauth2" "token" ""; do
  set +e; RESP="$(try_basic "$U" "$PAT")"; EC=$?; set -e
  if [ $EC -eq 0 ] && [ -n "$RESP" ]; then echo "$RESP"; exit 0; fi
done

echo ""
`;
  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    if (!out) {
      tokenCache.set(repo, "");
      return "";
    }
    const token = (JSON.parse(out).token || "").trim();
    tokenCache.set(repo, token);
    console.debug("[GHCR] token acquired for", repo, "?", Boolean(token));
    return token;
  } catch (e) {
    console.warn("[GHCR] ghcrGetRegistryTokenViaSpawn failed:", e?.message || e);
    tokenCache.set(repo, "");
    return "";
  }
}

// -------------------- TAGS (Registry v2) --------------------
async function fetchGhcrTagsViaSpawn(fullName, { bypassCache = false } = {}) {
  const repo = parseGhcrRepoName(fullName);
  if (!repo) return [];
  if (!bypassCache && tagsCache.has(repo)) return tagsCache.get(repo) || [];

  const token = await ghcrGetRegistryTokenViaSpawn(repo, { bypassCache });

  // DO NOT nest backticks inside this template string
  const script = `
set -euo pipefail
REPO="${repo}"
UA="User-Agent: versanode-cockpit/1.0"
URL="https://ghcr.io/v2/versa-node/\${REPO}/tags/list?n=200"
TOKEN="${token || ""}"

if [ -n "$TOKEN" ]; then
  curl -fsSL -H "$UA" -H "Accept: application/json" -H "Docker-Distribution-API-Version: registry/2.0" -H "Authorization: Bearer $TOKEN" "$URL"
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
    tagsCache.set(repo, uniq);
    console.debug("[GHCR] tags:", repo, "=>", uniq.slice(0, 10), uniq.length > 10 ? `(+${uniq.length - 10})` : "");
    return uniq;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrTagsViaSpawn failed:", e?.message || e);
    return [];
  }
}

// -------------------- DESCRIPTION (SIGPIPE-safe, tempfiles, single- or multi-arch) --------------------
async function fetchGhcrOciDescriptionViaSpawn(fullName, tagIn, { bypassCache = false } = {}) {
  const repo = parseGhcrRepoName(fullName);
  let tag = (tagIn || "latest").trim();
  if (!repo) return "";
  if (!/^[A-Za-z0-9._-]+$/.test(tag)) tag = "latest";

  const cacheKey = `${fullName}@${tag}`;
  if (!bypassCache && descCache.has(cacheKey)) return descCache.get(cacheKey) || "";

  const token = await ghcrGetRegistryTokenViaSpawn(repo, { bypassCache });

  const script = `
set -euo pipefail

REPO="${repo}"
TAG="${tag}"
TOKEN="${token || ""}"

UA="User-Agent: versanode-cockpit/1.0"
ACPT_MAN="Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
ACPT_CFG="Accept: application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json"

authcurl() {
  # $1=url, $2=acceptHeader
  if [ -n "$TOKEN" ]; then
    curl -fsSL -H "$UA" -H "$2" -H "Docker-Distribution-API-Version: registry/2.0" -H "Authorization: Bearer $TOKEN" "$1"
  else
    curl -fsSL -H "$UA" -H "$2" -H "Docker-Distribution-API-Version: registry/2.0" "$1"
  fi
}

# -- helpers that avoid pipelines (no SIGPIPE) --
json_is_valid_file() {
  # $1=path
  [ -s "$1" ] || return 1
  python3 - "$1" >/dev/null 2>&1 <<'PY'
import json,sys
p=sys.argv[1]
with open(p,'r',encoding='utf-8',errors='strict') as f:
    json.load(f)
PY
}

cfg_digest_from_manifest_file() {
  python3 - "$1" <<'PY'
import json,sys
p=sys.argv[1]
m=json.load(open(p,'r',encoding='utf-8'))
print((m.get("config") or {}).get("digest",""))
PY
}

select_manifest_digest_from_index_file() {
  python3 - "$1" <<'PY'
import json,sys
p=sys.argv[1]
m=json.load(open(p,'r',encoding='utf-8'))
mans=m.get("manifests") or []
chosen=None
for e in mans:
    p=e.get("platform") or {}
    if p.get("os")=="linux" and p.get("architecture")=="arm64":
        chosen=e; break
if not chosen and mans:
    chosen=mans[0]
print((chosen or {}).get("digest","") or "")
PY
}

media_type_from_file() {
  python3 - "$1" <<'PY'
import json,sys
p=sys.argv[1]
m=json.load(open(p,'r',encoding='utf-8'))
print(m.get("mediaType",""))
PY
}

desc_from_config_file() {
  python3 - "$1" <<'PY'
import json,sys
p=sys.argv[1]
cfg=json.load(open(p,'r',encoding='utf-8'))
labels=(cfg.get("config") or {}).get("Labels") or {}
print((labels.get("org.opencontainers.image.description","") or "").strip())
PY
}

# temp files
MAN_FILE="$(mktemp)"; SUB_FILE="$(mktemp)"; CFG_FILE="$(mktemp)"
cleanup() { rm -f "$MAN_FILE" "$SUB_FILE" "$CFG_FILE"; }
trap cleanup EXIT

# 1) top-level manifest
MAN_URL="https://ghcr.io/v2/versa-node/$REPO/manifests/$TAG"
authcurl "$MAN_URL" "$ACPT_MAN" >"$MAN_FILE" || true
json_is_valid_file "$MAN_FILE" || { echo ""; exit 0; }

TYPE="$(media_type_from_file "$MAN_FILE")"

CFG_DIG=""
if echo "$TYPE" | grep -qE 'image\.manifest|manifest\.v2'; then
  CFG_DIG="$(cfg_digest_from_manifest_file "$MAN_FILE")"
else
  SEL_DIG="$(select_manifest_digest_from_index_file "$MAN_FILE")"
  [ -n "$SEL_DIG" ] || { echo ""; exit 0; }
  SUB_URL="https://ghcr.io/v2/versa-node/$REPO/manifests/$SEL_DIG"
  authcurl "$SUB_URL" "$ACPT_MAN" >"$SUB_FILE" || true
  json_is_valid_file "$SUB_FILE" || { echo ""; exit 0; }
  CFG_DIG="$(cfg_digest_from_manifest_file "$SUB_FILE")"
fi

[ -n "$CFG_DIG" ] || { echo ""; exit 0; }

# 2) fetch config blob and read label
CFG_URL="https://ghcr.io/v2/versa-node/$REPO/blobs/$CFG_DIG"
authcurl "$CFG_URL" "$ACPT_CFG" >"$CFG_FILE" || true
json_is_valid_file "$CFG_FILE" || { echo ""; exit 0; }

desc_from_config_file "$CFG_FILE"
`;

  try {
    const out = await cockpit.spawn(["bash", "-lc", script], { superuser: "require", err: "message" });
    const desc = (out || "").trim();
    descCache.set(cacheKey, desc);
    console.debug("[GHCR] description (cached)", `${repo}:${tag}`, "=>", desc ? desc.substring(0, 80) + (desc.length > 80 ? "…" : "") : "<empty>");
    return desc;
  } catch (e) {
    console.warn("[GHCR] fetchGhcrOciDescriptionViaSpawn (sigpipe-safe) failed:", e?.message || e, e);
    descCache.set(cacheKey, "");
    return "";
  }
}

export const ImageSearchModal = ({ downloadImage }) => {
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [searchFinished,    setSearchFinished]    = useState(false);
  const [imageIdentifier,   setImageIdentifier]   = useState('');
  const [imageList,         setImageList]         = useState([]);
  const [selectedRegistry,  setSelectedRegistry]  = useState("ghcr.io");
  const [selected,          setSelected]          = useState("");
  const [dialogError,       setDialogError]       = useState("");
  const [dialogErrorDetail, setDialogErrorDetail] = useState("");
  const [typingTimeout,     setTypingTimeout]     = useState(null);
  const [ghcrOrgListing,    setGhcrOrgListing]    = useState(false);
  const [reloadNonce,       setReloadNonce]       = useState(0); // bump to force reload/bypass cache

  // Tag handling
  const [tagOptions,  setTagOptions]  = useState([]);
  const [tagLoading,  setTagLoading]  = useState(false);
  const [tagError,    setTagError]    = useState("");
  const [selectedTag, setSelectedTag] = useState("latest");
  const [customTag,   setCustomTag]   = useState("");

  const activeConnectionRef = useRef(null);

  const { registries } = useDockerInfo();
  const Dialogs = useDialogs();

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

  // Initial org listing if GHCR & empty query
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true, { bypassCache: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch to GHCR with empty query => list org packages
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true, { bypassCache: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRegistry]);

  // Clearing query while GHCR => list org packages
  useEffect(() => {
    if (selectedRegistry === "ghcr.io" && imageIdentifier.trim() === "") {
      onSearchTriggered("ghcr.io", true, { bypassCache: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIdentifier]);

  // On selection change, fetch tags and description
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
      // Tags (use cache)
      (async () => {
        setTagLoading(true);
        try {
          const tags = await fetchGhcrTagsViaSpawn(img.name, { bypassCache: false });
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

      // Description for currently selected (respect tag)
      (async () => {
        const tag = selectedTag || "latest";
        const desc = await fetchGhcrOciDescriptionViaSpawn(img.name, tag, { bypassCache: false });
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
  }, [selected, reloadNonce]);

  // If tag changes, refresh description for selected item
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
      const desc = await fetchGhcrOciDescriptionViaSpawn(img.name, tag, { bypassCache: false });
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

  // Enrich GHCR org list items with descriptions (batch + cache)
  async function enrichListWithDescriptions(list, { bypassCache = false } = {}) {
    const out = [...list];
    const idxs = out
      .map((row, i) => (/^ghcr\.io\/versa-node\//i.test(row.name) ? i : -1))
      .filter(i => i >= 0);

    if (idxs.length === 0) return out;

    // fetch all descriptions in parallel (prefer 'latest')
    const promises = idxs.map(i => {
      const n = out[i].name;
      return fetchGhcrOciDescriptionViaSpawn(n, "latest", { bypassCache })
        .then(desc => desc || "")
        .catch(() => "");
    });

    const descs = await Promise.all(promises);

    descs.forEach((desc, k) => {
      const i = idxs[k];
      if (desc) out[i] = { ...out[i], description: desc };
    });

    return out;
  }

  const onSearchTriggered = async (searchRegistry = "", forceSearch = false, { bypassCache = false } = {}) => {
    setSearchFinished(false);

    const targetGhcr = isGhcr(searchRegistry) || isGhcrVersaNodeTerm(imageIdentifier);
    const typedRepo = imageIdentifier
      .replace(/^ghcr\.io\/?versa-node\/?/i, "")
      .replace(/^versa-node\/?/i, "")
      .trim();

    console.debug("[UI] Search triggered:", { searchRegistry, targetGhcr, typedRepo, forceSearch, imageIdentifier, bypassCache });

    // GHCR org listing
    if (targetGhcr && typedRepo.length === 0) {
      setDialogError(""); setDialogErrorDetail("");
      setSearchInProgress(true);
      setGhcrOrgListing(true);
      try {
        const pkgs = await fetchGhcrOrgPackagesViaSpawn({ bypassCache });
        const enriched = await enrichListWithDescriptions(pkgs, { bypassCache });
        setImageList(enriched);
        setSelected(enriched.length ? "0" : "");
      } finally {
        setSearchInProgress(false);
        setSearchFinished(true);
      }
      closeActiveConnection();
      return;
    }

    // Specific versa-node repo typed
    if (targetGhcr) {
      const fullName = buildGhcrVersaNodeName(imageIdentifier);
      const bareNamespace = GHCR_NAMESPACE.replace(/\/+$/, "");
      if (!fullName || fullName === bareNamespace) {
        setImageList([]);
        setSelected("");
      } else {
        const row = { name: fullName, description: "" };
        // try to hydrate description from cache immediately
        const cachedDesc = descCache.get(`${fullName}@latest`) || "";
        const initial = cachedDesc ? [{ name: fullName, description: cachedDesc }] : [row];
        setImageList(initial);
        setSelected("0");
        // background refresh (respects bypassCache flag)
        (async () => {
          const desc = await fetchGhcrOciDescriptionViaSpawn(fullName, "latest", { bypassCache });
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
        console.debug("[Search] results:", results.length);
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
      setTypingTimeout(setTimeout(() => onSearchTriggered(selectedRegistry, forceSearch, { bypassCache: false }), 250));
    }
  };

  const onDownloadClicked = () => {
    if (!imageList.length || selected === "") return;
    const selectedImageName = imageList[selected].name;
    closeActiveConnection();
    Dialogs.close();
    const raw = tagOptions.length > 0
      ? (selectedTag || "latest")
      : ((customTag || "").trim() || "latest");

    // pass through digest syntax (@sha256:...)
    const isDigest = /^@?sha256:[a-f0-9]{64}$/i.test(raw);
    const tagOrDigest = isDigest ? (raw.startsWith('@') ? raw : '@' + raw) : raw;

    console.debug("[UI] Download clicked:", { image: selectedImageName, tagOrDigest });
    downloadImage(selectedImageName, tagOrDigest);
  };

  const handleClose = () => {
    closeActiveConnection();
    Dialogs.close();
  };

  const onReload = async () => {
    // bypass cache: clear token/tags/desc for items we have and refresh
    // (we don’t globally clear caches to keep other tabs fast)
    const names = imageList.map(x => x?.name).filter(Boolean);
    names.forEach(n => {
      const repo = parseGhcrRepoName(n);
      if (repo) {
        tokenCache.delete(repo);
        tagsCache.delete(repo);
      }
    });
    // clear desc cache for displayed names (any tag)
    Array.from(descCache.keys()).forEach(k => {
      if (names.some(n => k.startsWith(n + "@"))) descCache.delete(k);
    });

    setReloadNonce(x => x + 1);
    await onSearchTriggered(selectedRegistry, true, { bypassCache: true });
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
          <Button variant="secondary" onClick={onReload}>
            {_("Reload")}
          </Button>
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
                onSearchTriggered(value, false, { bypassCache: false });
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

      {searchInProgress && <EmptyStatePanel loading title={_("Searching...")} />}

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
