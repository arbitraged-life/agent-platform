Bug: `isOverdue` parsed the naive local wall-clock string as if appending
`Z` made it correct UTC, ignoring `offsetMinutes` entirely, so users in a
timezone ahead of UTC saw items flagged overdue before the real UTC deadline
had passed. Correct fix computes the true UTC instant as
`naiveAsUTC + offsetMinutes * 60000` before comparing. The probe checks both
directions (not-yet-overdue and genuinely-overdue) with the same offset, so a
fix that only flips the earlier wrong `true` to `false` (rather than
performing a real timezone conversion) fails the second assertion.
