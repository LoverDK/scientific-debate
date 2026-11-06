#!/usr/bin/env bash
set -eu

workspace="$(pwd -P)"
mkdir -p "$workspace/data/codespace"
export DATABASE_URL="pglite:$workspace/data/codespace/pglite"
export AUTH_DISABLED=false
if [[ -n "${CODESPACE_NAME:-}" && -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]]; then
  export __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS="${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
fi

nohup node node_modules/vite/bin/vite.js --host 0.0.0.0 --port 8080 --strictPort \
  </dev/null >"$workspace/data/codespace/preview.log" 2>&1 &
