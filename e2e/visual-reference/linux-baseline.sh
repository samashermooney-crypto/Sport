#!/usr/bin/env bash
# Regenerates the Linux parity baselines inside the Playwright container:
#   docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble \
#     bash e2e/visual-reference/linux-baseline.sh
# Requires npm ci to have run in the container first (Linux node_modules).
set -euo pipefail

# Legacy app dependencies are no longer root deps. Install them separately so
# baseline generation keeps the exact dependency tree from the root lockfile.
LEGACY_DEPENDENCIES="$(mktemp -d)"
LEGACY_VITE_CONFIG_DIR=''
LEGACY_API_PID=''
LEGACY_WEB_PID=''
NEW_WEB_PID=''

cleanup() {
  for pid in "$LEGACY_API_PID" "$LEGACY_WEB_PID" "$NEW_WEB_PID"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
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

# The legacy and current apps share the root node_modules directory. Give the
# legacy Vite process a separate optimizer cache so its dependency prebundle
# cannot be replaced while the current app warms its own module graph.
LEGACY_VITE_CONFIG_DIR="$(mktemp -d "$PWD/legacy/.vite-parity.XXXXXX")"
cat > "$LEGACY_VITE_CONFIG_DIR/vite.config.mjs" <<'VITE_CONFIG'
import { mergeConfig } from 'vite';
import legacyConfig from '../../legacy/vite.config.ts';

export default mergeConfig(legacyConfig, {
  cacheDir: '/tmp/athlentry-legacy-vite-cache',
});
VITE_CONFIG

# legacy/index.html references /src/main.tsx; the vendored tree calls it web/.
ln -sfn web legacy/src

DATABASE_PATH=/tmp/legacy-parity.db PORT=3001 node legacy/server/index.mjs &
LEGACY_API_PID=$!
(cd legacy && node /work/node_modules/vite/bin/vite.js \
  --config "$LEGACY_VITE_CONFIG_DIR/vite.config.mjs" \
  --port 5173 --strictPort) &
LEGACY_WEB_PID=$!
ATHLENTRY_VITE_PORT=5174 node_modules/.bin/vite --config vite.config.ts &
NEW_WEB_PID=$!

# Wait for both dev servers.
for url in http://127.0.0.1:5173/ http://127.0.0.1:5174/; do
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "$url"; then break; fi
    sleep 1
  done
done

# The legacy login screen requires its initial /api/session request to return
# 401 before the demo credentials are rendered. Wait for the API behind Vite's
# proxy as well as both frontend servers so a cold API startup cannot replace
# the login screen with a transient session-load error.
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

# Prime the new app's module graph before Playwright starts; a cold Vite
# transform can otherwise race the first heading checks.
node --input-type=module <<'WARMUP'
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5174/__ui');
  await page.getByRole('heading', { name: 'Design system' }).waitFor({
    timeout: 120_000,
  });
  await page.evaluate(() => document.fonts.ready);
} finally {
  await browser.close();
}
WARMUP

LEGACY_URL=http://127.0.0.1:5173 node e2e/visual-reference/capture-linux.mjs
LINUX_BASELINE_BASE_URL=http://127.0.0.1:5174 \
  npx playwright test --config e2e/visual-reference/linux-baseline.config.mjs \
  --project=chromium-desktop --workers=1 --update-snapshots
LINUX_BASELINE_BASE_URL=http://127.0.0.1:5174 \
  npx playwright test --config e2e/visual-reference/linux-baseline.config.mjs \
  --project=webkit-mobile --workers=1 \
  --grep 'shell stays within phone width' --update-snapshots
