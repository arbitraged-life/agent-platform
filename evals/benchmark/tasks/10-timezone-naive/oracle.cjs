const assert = require('assert');
const path = require('path');
const { isOverdue } = require(path.join(process.argv[2], 'lib.js'));

// deadline is 2026-09-12T12:00:00Z. True current instant is 11:50Z (10 min
// before deadline -> NOT overdue). The naive local reading, in a timezone 5
// hours ahead of UTC (offsetMinutes = -300), is "16:50" with no tz marker.
const deadlineISO = '2026-09-12T12:00:00Z';

const notYetOverdue = isOverdue(deadlineISO, '2026-09-12T16:50:00', -300);
assert.strictEqual(notYetOverdue, false, 'expected not-overdue when correctly timezone-adjusted (true UTC instant is before the deadline)');

// same timezone, but now truly past the deadline (true instant 12:10Z)
const genuinelyOverdue = isOverdue(deadlineISO, '2026-09-12T17:10:00', -300);
assert.strictEqual(genuinelyOverdue, true, 'expected overdue once the true UTC instant has passed the deadline');

console.log('OK: overdue check is timezone-correct in both directions');
