#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
class Store {
  constructor(initial) {
    this.data = { ...initial };
    this.cache = {};
  }

  get(key) {
    if (Object.prototype.hasOwnProperty.call(this.cache, key)) return this.cache[key];
    const v = this.data[key];
    this.cache[key] = v;
    return v;
  }

  delete(key) {
    delete this.data[key]; // BUG: cache entry for `key` is never invalidated
  }
}

module.exports = { Store };
JS
