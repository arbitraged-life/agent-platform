Bug: `handle`'s catch block mapped every thrown error, validation or not, to
`status: 500`, so a malformed-payload validation failure looked identical to
a genuine server fault to API clients. Correct fix introduces a distinguishable
`ValidationError` (thrown for the validation case only, carrying the invalid
field name) and has the catch block special-case it as 400 with the field
named in the body, while any other error type still maps to 500. The probe's
`trigger: 'boom'` case is the plausible-failure catch: a fix that blanket-maps
"any thrown Error" to 400 (rather than distinguishing validation errors
specifically) passes the reported case but wrongly turns real server faults
into 400s too.
