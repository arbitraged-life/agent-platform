# Ticket: Failed writes report success

`handleWrite(writeFn)` in `lib.js` calls an async `writeFn()` and returns
`{ ok: true }`. Support reports that failed writes (writeFn rejects) are
silently reported to the caller as success.

Fix `handleWrite` so that when `writeFn()` rejects, the returned value is
`{ ok: false, error: <message> }`; when it resolves, the return is still
`{ ok: true }`.
