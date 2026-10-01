# Ticket: slug generator collapses two different tickets to the same slug

`slugify(input)` in `lib.js` derives a URL-safe slug from arbitrary
multi-line text (e.g. a ticket title + body). Two different tickets whose
titles happen to match but whose bodies differ are getting assigned the
*same* slug, causing an identifier collision downstream.

Fix `slugify` so it accounts for the full input (not just the first line),
while remaining deterministic: the same input must always produce the same
slug (no randomness/timestamps).
