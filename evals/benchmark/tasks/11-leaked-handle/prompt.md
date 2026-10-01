# Ticket: file descriptors leak when a file fails validation

`processFiles(paths)` in `lib.js` opens each path, checks its first 3 bytes,
and records `{ path, ok }` per file. Under a long-running batch with many
`BAD`-content files, the process eventually hits `EMFILE` (too many open
files).

Fix `processFiles` so every file descriptor it opens gets closed, on every
code path (including the "BAD content" branch), while still reporting
`{ path, ok: false }` for bad files and continuing to the next one.
