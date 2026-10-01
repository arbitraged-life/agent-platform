Bug: `delete(key)` removed the row from the backing `data` map but left the
read-through `cache[key]` entry in place, so a GET immediately after a DELETE
still returned the old cached value (a stale-200-instead-of-404 bug). Correct
fix also deletes `cache[key]`. The probe warms the cache for a second,
unrelated key and asserts it survives the delete: a plausible-but-wrong "fix"
that clears the *entire* cache on any delete (rather than just the deleted
key) fails that assertion.
