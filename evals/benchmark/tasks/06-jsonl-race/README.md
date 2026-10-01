Bug: `appendLine` opened the file in append mode but wrote each line's bytes
in two separate `writeSync` calls with an `await` (yield point) between them,
so a concurrent writer's full line could interleave in the gap, producing a
corrupted/partial JSON line. Correct fix issues the whole line as a single
`write`/`appendFileSync` call with no yield point in the middle, which POSIX
append-mode writes handle atomically for line-sized buffers. The probe runs
20 truly concurrent appends and checks both that every line parses as JSON
*and* that none were lost, catching a plausible near-miss that adds a lock
around the two-write sequence but still loses lines under contention.
