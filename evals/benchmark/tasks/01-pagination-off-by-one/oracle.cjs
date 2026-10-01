const assert = require('assert');
const path = require('path');
const { paginate } = require(path.join(process.argv[2], 'lib.js'));

const rows = Array.from({ length: 24 }, (_, i) => ({ id: i }));
const total = 23;

const last = paginate(rows, 3, 10, total);
assert.strictEqual(last.length, 3, `expected 3 items on last page, got ${last.length}`);

const page2 = paginate(rows, 2, 10, total);
assert.strictEqual(page2.length, 10, `expected 10 items on page 2, got ${page2.length}`);

const page4 = paginate(rows, 4, 10, total);
assert.strictEqual(page4.length, 0, `expected 0 items on page 4 (past total), got ${page4.length}`);

console.log('OK: pagination respects total across pages');
