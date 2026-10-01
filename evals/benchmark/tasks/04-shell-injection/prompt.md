# Ticket: `greet(name)` executes arbitrary shell commands via `name`

`greet(name)` in `lib.js` builds a shell command string from user input and
runs it. A security scan flagged that any `name` value is executed as shell
syntax rather than treated as plain data — for example a name containing
`; touch /tmp/pwned` runs the injected command.

Fix `greet` so `name` can never be interpreted as shell syntax, for any
injection style (`;`, `` ` ``, `$(...)`, `&&`, etc.), while still printing
"hello <name>" for ordinary names.
