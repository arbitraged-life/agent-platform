const assert = require('assert');
const path = require('path');
const { parseConfig } = require(path.join(process.argv[2], 'lib.js'));

const crlf = 'a=1\r\nb=2\r\nc= 3 \r\n';
const parsed = parseConfig(crlf);
assert.strictEqual(parsed.a, '1', `expected a='1', got ${JSON.stringify(parsed.a)}`);
assert.strictEqual(parsed.b, '2', `expected b='2' with no trailing CR, got ${JSON.stringify(parsed.b)}`);
assert.strictEqual(parsed.c, ' 3 ', `expected surrounding spaces preserved (only CR stripped), got ${JSON.stringify(parsed.c)}`);

const lf = 'x=9\ny=8\n';
const parsedLf = parseConfig(lf);
assert.strictEqual(parsedLf.x, '9');
assert.strictEqual(parsedLf.y, '8');

console.log('OK: CRLF handled, LF unaffected, meaningful spaces preserved');
