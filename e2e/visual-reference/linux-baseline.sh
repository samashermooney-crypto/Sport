#!/usr/bin/env bash
# Captures Linux legacy shell references on the same hosted runner that runs
# the e2e suite. Current-app screenshots remain fixed Playwright snapshots and
# are never rewritten by this script.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

if [ "$(uname -s)" != 'Linux' ] || [ "$(uname -m)" != 'x86_64' ]; then
  echo 'Linux parity references require an x86_64 GitHub Actions runner.' >&2
  exit 1
fi
if [ "${GITHUB_ACTIONS:-}" != 'true' ] || [ -e /.dockerenv ] || \
  ! grep -q '^VERSION_ID="24.04"$' /etc/os-release; then
  echo 'Capture Linux references on the hosted ubuntu-24.04 runner.' >&2
  exit 1
fi

# Legacy dependencies stay isolated from the root lockfile. The current and
# legacy apps share root node_modules, so the legacy Vite process gets its own
# optimizer cache.
LEGACY_DEPENDENCIES="$(mktemp -d)"
LEGACY_VITE_CONFIG_DIR=''
LEGACY_API_PID=''
LEGACY_WEB_PID=''

cleanup() {
  for pid in "$LEGACY_API_PID" "$LEGACY_WEB_PID"; do
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  rm -f legacy/node_modules legacy/src
  if [ -n "$LEGACY_VITE_CONFIG_DIR" ]; then rm -rf "$LEGACY_VITE_CONFIG_DIR"; fi
  rm -rf "$LEGACY_DEPENDENCIES"
}
trap cleanup EXIT

ln -sfn "$LEGACY_DEPENDENCIES/node_modules" legacy/node_modules
npm install --prefix "$LEGACY_DEPENDENCIES" --no-save --package-lock=false \
  --no-audit --no-fund dompurify@3 lucide-react@0.468.0 sanitize-html@2 \
  react-router-dom@7

LEGACY_VITE_CONFIG_DIR="$(mktemp -d "$PWD/legacy/.vite-parity.XXXXXX")"
cat > "$LEGACY_VITE_CONFIG_DIR/vite.config.mjs" <<'VITE_CONFIG'
import { mergeConfig } from 'vite';
import legacyConfig from '../../legacy/vite.config.ts';

export default mergeConfig(legacyConfig, {
  cacheDir: '/tmp/athlentry-legacy-vite-cache',
});
VITE_CONFIG

ln -sfn web legacy/src
DATABASE_PATH=/tmp/legacy-parity.db PORT=3001 node legacy/server/index.mjs &
LEGACY_API_PID=$!
(
  cd "$REPO_ROOT/legacy"
  exec "$REPO_ROOT/node_modules/.bin/vite" \
    --config "$LEGACY_VITE_CONFIG_DIR/vite.config.mjs" \
    --port 5173 --strictPort
) &
LEGACY_WEB_PID=$!

for _ in $(seq 1 60); do
  if curl -fs -o /dev/null http://127.0.0.1:5173/; then break; fi
  sleep 1
done

legacy_api_status=''
for _ in $(seq 1 60); do
  legacy_api_status=$(curl -sS -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:5173/api/session || true)
  if [ "$legacy_api_status" = '401' ]; then break; fi
  sleep 1
done
if [ "$legacy_api_status" != '401' ]; then
  echo "Legacy API did not become ready (last /api/session status: ${legacy_api_status:-unavailable})" >&2
  exit 1
fi

LEGACY_URL=http://127.0.0.1:5173 node e2e/visual-reference/capture-linux.mjs
