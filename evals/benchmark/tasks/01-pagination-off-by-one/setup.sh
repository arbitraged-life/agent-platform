#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
function paginate(rows, page, pageSize, total) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize; // BUG: never clamps to `total`, so soft-deleted/
                                 // trailing rows beyond the reported total leak
                                 // into the last page.
  return rows.slice(start, end);
}

module.exports = { paginate };
JS
