#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
function parseConfig(text) {
  const lines = text.split('\n');
  const entries = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1); // BUG: trailing \r survives on CRLF input
    entries[key] = value;
  }
  return entries;
}

module.exports = { parseConfig };
JS
