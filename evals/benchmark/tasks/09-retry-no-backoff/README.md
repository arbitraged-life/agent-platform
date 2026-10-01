Bug: `fetchWithRetry` looped on 429 responses with no delay between attempts,
so it retried near-instantly and exhausted `maxAttempts` well before any
realistic rate-limit window elapsed, throwing instead of succeeding. Correct
fix adds a backoff (e.g. exponential: `50 * 2**attempt`ms, capped) between
retries. The probe uses a stub that only stops returning 429 once real wall-
clock time has passed, so a fix must actually wait (not just "add a retry"),
and it also bounds total elapsed time and call count to catch a plausible
near-miss that "backs off" by sleeping one huge fixed duration on every call.
