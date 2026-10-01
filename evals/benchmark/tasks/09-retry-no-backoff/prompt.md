# Ticket: client never recovers from a 429

`fetchWithRetry(fetchFn, maxAttempts)` in `lib.js` retries `fetchFn()` while
it returns `{ status: 429 }`. Against a real rate-limited backend the client
exhausts its retries and throws, because it retries in a tight loop instead
of waiting out the rate-limit window.

Fix `fetchWithRetry` to back off between retries (e.g. exponential backoff)
so it eventually succeeds once the rate-limit window has passed, without
waiting an unreasonably long fixed time on every call.
