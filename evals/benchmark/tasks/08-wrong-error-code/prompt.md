# Ticket: malformed request bodies return 500 instead of 400

`handle(payload)` in `lib.js` returns `{ status, body }`. Client-side
validation failures (missing/blank `name`) currently come back as
`status: 500` with a generic message. Clients need `status: 400` with a body
that names which field was invalid, so they can show a useful error instead
of retrying a "server error".

Fix this WITHOUT turning genuine unexpected internal errors (anything other
than the validation case) into 400s — those must still be 500.
