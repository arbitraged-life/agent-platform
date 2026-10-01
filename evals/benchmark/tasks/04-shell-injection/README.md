Bug: `greet` interpolated raw user input directly into a shell command string
passed to `execSync`, so any shell metacharacters in `name` (`;`, `$(...)`,
backticks, `&&`, ...) execute as commands. Correct fix avoids a shell
entirely, e.g. `execFileSync('echo', ['hello', name])`, which passes `name`
as a single argv entry with no shell parsing. The probe checks two distinct
injection styles (`;` and `$(...)`) because a narrow fix that only escapes
semicolons (the reported case) still lets command substitution through.
