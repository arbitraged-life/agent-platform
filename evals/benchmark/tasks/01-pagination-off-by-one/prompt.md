# Ticket: Last page of paginated list returns one extra row

`paginate(rows, page, pageSize, total)` in `lib.js` is supposed to return at
most `pageSize` rows per page, never more than `total` rows across all pages.

QA reports: with 23 total real rows (page size 10), requesting page 3 returns
4 rows instead of 3. The underlying row store has a 24th physical row (a
soft-deleted leftover) that must never be surfaced through pagination.

Fix `paginate` so:
- page 3 of a 23-row/10-per-page listing returns exactly 3 rows
- earlier full pages still return exactly `pageSize` rows
- requesting a page entirely past `total` returns an empty array

Do not special-case "page 3"; the fix must generalize to any page/pageSize/total.
