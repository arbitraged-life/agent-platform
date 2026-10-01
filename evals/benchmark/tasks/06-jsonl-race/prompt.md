# Ticket: concurrent JSONL appends produce corrupted lines

`appendLine(filePath, obj)` in `lib.js` appends one JSON object as a line to
a `.jsonl` log file. Under concurrent load (many callers appending at once)
some lines in the resulting file fail to parse as JSON — writes are
interleaving mid-line.

Fix `appendLine` so that when many calls run concurrently against the same
file, every resulting non-empty line is valid, complete JSON and no lines are
silently lost.
