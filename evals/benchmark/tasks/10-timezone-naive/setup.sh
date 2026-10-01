#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
function isOverdue(deadlineISO, nowNaiveLocal, offsetMinutes) {
  const deadline = new Date(deadlineISO).getTime();
  // BUG: treats a naive local wall-clock reading as if it were already UTC,
  // ignoring `offsetMinutes` entirely.
  const naiveAsUTC = new Date(nowNaiveLocal + 'Z').getTime();
  return naiveAsUTC > deadline;
}

module.exports = { isOverdue };
JS
