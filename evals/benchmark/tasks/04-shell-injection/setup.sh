#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
const { execSync } = require('child_process');

function greet(name) {
  // BUG: unescaped string interpolation into a shell command
  return execSync(`echo hello ${name}`).toString();
}

module.exports = { greet };
JS
