Bug: the parser split on `\n` only, leaving a trailing `\r` on every line
parsed out of a `\r\n`-terminated file, so `entries[key]` values silently
carried an invisible `\r`. Correct fix strips only a trailing `\r` (e.g.
split on `/\r?\n/` or strip `line.replace(/\r$/, '')`) rather than trimming
whitespace generally. The probe includes a value with meaningful internal
spaces (`c= 3 `) to catch a plausible near-miss that blanket-`.trim()`s the
value and strips the intentional spaces along with the `\r`.
