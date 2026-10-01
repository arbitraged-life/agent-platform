const assert = require('assert');
const path = require('path');
const { slugify } = require(path.join(process.argv[2], 'lib.js'));

const a = 'Deploy Fix\nfor server A';
const b = 'Deploy Fix\nfor server B';

const slugA = slugify(a);
const slugB = slugify(b);
assert.notStrictEqual(slugA, slugB, `expected different slugs for different inputs, both got ${JSON.stringify(slugA)}`);

// idempotency: a naive fix that appends Date.now()/Math.random() to dodge
// collisions would break this.
assert.strictEqual(slugify(a), slugA, 'slugify must be deterministic/idempotent for the same input');

console.log('OK: distinct multi-line inputs get distinct, deterministic slugs');
