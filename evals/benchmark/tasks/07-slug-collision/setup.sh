#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
function slugify(input) {
  // BUG: only the first line is considered, so two multi-line inputs that
  // differ only after an embedded newline collide on the same slug.
  const firstLine = input.split('\n')[0];
  return firstLine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

module.exports = { slugify };
JS
