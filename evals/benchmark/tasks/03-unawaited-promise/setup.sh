#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
async function handleWrite(writeFn) {
  writeFn().catch(() => {}); // BUG: fire-and-forget, caller never sees the failure
  return { ok: true };
}

module.exports = { handleWrite };
JS
