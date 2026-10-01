#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
const fs = require('fs');

let openHandles = 0;
function _open(p) {
  openHandles++;
  return fs.openSync(p, 'r');
}
function _close(fd) {
  fs.closeSync(fd);
  openHandles--;
}
function getOpenHandleCount() {
  return openHandles;
}

function processFiles(paths) {
  const results = [];
  for (const p of paths) {
    const fd = _open(p);
    const buf = Buffer.alloc(3);
    fs.readSync(fd, buf, 0, 3, 0);
    if (buf.toString() === 'BAD') {
      // BUG: skips this file without closing its handle first
      results.push({ path: p, ok: false });
      continue;
    }
    _close(fd);
    results.push({ path: p, ok: true });
  }
  return results;
}

module.exports = { processFiles, getOpenHandleCount };
JS
