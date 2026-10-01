Bug: `handleWrite` invoked `writeFn()` without awaiting it, attaching a
no-op `.catch()` and immediately returning `{ ok: true }` — a classic
fire-and-forget that hides write failures from the caller. Correct fix
awaits `writeFn()` inside a try/catch and returns `{ ok: false, error }` on
rejection. The probe also exercises the success path (`writeFn` resolves) to
catch a plausible near-miss where a model always returns `ok:false` or wraps
the call in a way that breaks the success case.
