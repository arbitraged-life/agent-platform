Bug: `slugify` truncated input to its first line before slugging, so two
inputs sharing a title but differing in body (after an embedded newline)
produced the same slug. Correct fix slugs the whole input (e.g. run the
`[^a-z0-9]+` collapse over the entire string, letting embedded newlines
become part of the collapsed separator). The probe also asserts idempotency
on repeated calls with the same input, catching a plausible near-miss that
"fixes" collisions by appending a random or time-based suffix instead of
actually deriving the slug from the full content.
