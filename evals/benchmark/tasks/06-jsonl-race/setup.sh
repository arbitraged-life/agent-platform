#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
const fs = require('fs');

async function appendLine(filePath, obj) {
  const line = JSON.stringify(obj) + '\n';
  const buf = Buffer.from(line);
  const fd = fs.openSync(filePath, 'a');
  // BUG: splits a single logical line across two separate write() syscalls
  // with an await in between, so a concurrent writer's line can land in the
  // middle of this one.
  const mid = Math.floor(buf.length / 2) || 1;
  fs.writeSync(fd, buf.subarray(0, mid));
  await new Promise((resolve) => setTimeout(resolve, 5));
  fs.writeSync(fd, buf.subarray(mid));
  fs.closeSync(fd);
}

module.exports = { appendLine };
JS
