Bug: `paginate` computed a `[start, start+pageSize)` window and sliced the raw
row array without ever clamping to the caller-supplied `total`, so a 24th
physical (soft-deleted) row leaked onto the last page. Correct fix clamps the
window's end to `Math.min(start + pageSize, total)`. The probe requests a page
number past the end of the dataset and a full middle page: a fix that special-
cases "if this is the last page, drop the extra row" instead of generalizing
the clamp fails the page-4 (empty) and generalization checks.
