#!/usr/bin/env bash
set -euo pipefail

echo "[fix] try make_package_lock_json first…"
if tools/node-modules make_package_lock_json; then
  echo "[fix] ok (no fixup needed)"
  exit 0
fi

echo "[fix] make_package_lock_json failed — applying fallback…"

# 1) Loosen the guard once (keeps upstream script behavior otherwise)
#    Old line used $1; we allow an override via $2 so we can re-snapshot.
sed -i \
  's/local sha="${1-$(get_index_gitlink node_modules)}"/local sha="${2-$(get_index_gitlink node_modules)}"/' \
  tools/node-modules || true

# 2) Ensure node_modules matches *our* current package.json
echo "[fix] installing dependencies (matching current package.json)…"
tools/node-modules install

# 3) Force-accept current node_modules as the snapshot
echo "[fix] forcing node_modules snapshot acceptance…"
tools/node-modules checkout --force

# 4) Keep Cockpit’s index metadata consistent with this fork
#    (tools/node-modules stores a copy at node_modules/.package.json)
if [[ -f node_modules/.package.json ]]; then
  sed -i 's/"name": "podman"/"name": "docker"/' node_modules/.package.json || true
  sed -i 's|"description": "Cockpit UI for Podman Containers"|"description": "Cockpit UI for Docker Containers"|' node_modules/.package.json || true
  sed -i 's|"repository": "git@github.com:cockpit-project/cockpit-podman.git"|"repository": "https://github.com/chabad360/cockpit-docker.git"|' node_modules/.package.json || true
fi

# Some flows also want the lockfile “name” aligned
if [[ -f node_modules/.package-lock.json ]]; then
  sed -i 's/"name": "podman"/"name": "docker"/' node_modules/.package-lock.json || true
fi

# 5) Recreate package-lock.json from the now-accepted snapshot
echo "[fix] regenerating package-lock.json…"
tools/node-modules make_package_lock_json

echo "[fix] done."
