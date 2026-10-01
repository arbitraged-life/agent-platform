#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
async function fetchWithRetry(fetchFn, maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchFn();
    if (res.status !== 429) return res;
    // BUG: no delay before retrying -> hammers the server and never actually
    // waits out the rate-limit window.
  }
  throw new Error('exhausted retries');
}

module.exports = { fetchWithRetry };
JS
