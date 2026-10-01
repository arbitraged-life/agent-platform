# Ticket: DELETE then GET still returns the deleted value

`Store` in `lib.js` is a read-through cache: `get(key)` populates `cache[key]`
on first read. After `delete(key)` removes the row from `data`, a subsequent
`get(key)` must return `undefined` (the 404-equivalent), not the stale cached
value.

Fix `delete` so it invalidates the cache entry for that key, without clearing
unrelated cache entries for other keys.
