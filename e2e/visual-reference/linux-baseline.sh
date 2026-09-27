#!/usr/bin/env bash
# Regenerates the Linux parity baselines inside the Playwright container:
#   docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.63.0-noble \
#     bash e2e/visual-reference/linux-baseline.sh
# Requires npm ci to have run in the container first (Linux node_modules).
set -euo pipefail

# Legacy app dependencies are no longer root deps; install them side-effect free.
npm install --no-save --package-lock=false --no-audit --no-fund \
  dompurify@3 lucide-react@0.468.0 sanitize-html@2 react-router-dom@7

# legacy/index.html references /src/main.tsx; the vendored tree calls it web/.
ln -sfn web legacy/src

DATABASE_PATH=/tmp/legacy-parity.db PORT=3001 node legacy/server/index.mjs &
LEGACY_API_PID=$!
(cd legacy && node /work/node_modules/vite/bin/vite.js --port 5173 --strictPort) &
LEGACY_WEB_PID=$!
ATHLENTRY_VITE_PORT=5174 node_modules/.bin/vite --config vite.config.ts &
NEW_WEB_PID=$!

cleanup() {
  kill "$LEGACY_API_PID" "$LEGACY_WEB_PID" "$NEW_WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for both dev servers.
for url in http://127.0.0.1:5173/ http://127.0.0.1:5174/; do
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "$url"; then break; fi
    sleep 1
  done
done

LEGACY_URL=http://127.0.0.1:5173 node e2e/visual-reference/capture-linux.mjs
LINUX_BASELINE_BASE_URL=http://127.0.0.1:5174 \
  npx playwright test --config e2e/visual-reference/linux-baseline.config.mjs \
  --update-snapshots
