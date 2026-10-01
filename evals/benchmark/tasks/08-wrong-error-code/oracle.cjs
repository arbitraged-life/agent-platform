const assert = require('assert');
const path = require('path');
const { handle } = require(path.join(process.argv[2], 'lib.js'));

const missingName = handle({});
assert.strictEqual(missingName.status, 400, `expected 400 for missing name, got ${missingName.status}`);
assert.ok(String(missingName.body.error || missingName.body.field || '').toLowerCase().includes('name'),
  `expected the error body to name the invalid field, got ${JSON.stringify(missingName.body)}`);

const noPayload = handle(null);
assert.strictEqual(noPayload.status, 400, `expected 400 for a missing payload, got ${noPayload.status}`);

const ok = handle({ name: 'Ada' });
assert.strictEqual(ok.status, 200, `expected 200 for a valid payload, got ${ok.status}`);

// probe: a genuinely unexpected internal error must still be a 500, not blanket-converted to 400
const boom = handle({ name: 'Ada', trigger: 'boom' });
assert.strictEqual(boom.status, 500, `expected an unrelated internal error to remain a 500, got ${boom.status}`);

console.log('OK: validation errors are 400 with field info, internal errors remain 500');
