Bug: on the "BAD content" branch, `processFiles` pushed a result and
`continue`d without ever calling `_close(fd)`, leaking a file descriptor for
every bad file processed — unbounded growth under a long batch. Correct fix
wraps the per-file body in try/finally (or closes on both branches) so the
descriptor is always closed. The probe checks the open-handle counter is
back to zero *and* that bad files are still reported as `ok:false` and
processing doesn't abort early, catching a plausible near-miss that "fixes"
the leak by throwing/aborting on the first bad file instead of closing and
continuing.
