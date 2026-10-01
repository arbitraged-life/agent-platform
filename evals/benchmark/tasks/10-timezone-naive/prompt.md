# Ticket: "overdue" check is wrong for non-UTC timezones

`isOverdue(deadlineISO, nowNaiveLocal, offsetMinutes)` in `lib.js` should
determine whether the current moment is past a UTC deadline. `nowNaiveLocal`
is a *naive local wall-clock reading* (no timezone in the string, e.g.
`"2026-09-12T16:50:00"`) and `offsetMinutes` is the number of minutes to ADD
to that local reading to get true UTC (matching `Date.prototype.getTimezoneOffset()`
sign convention).

Users in timezones ahead of UTC report items marked overdue *before* the UTC
deadline has actually passed. Fix `isOverdue` to correctly convert
`nowNaiveLocal` + `offsetMinutes` into a true UTC instant before comparing.
