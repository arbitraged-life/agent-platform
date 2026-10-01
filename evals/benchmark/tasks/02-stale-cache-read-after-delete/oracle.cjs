const assert = require('assert');
const path = require('path');
const { Store } = require(path.join(process.argv[2], 'lib.js'));

const store = new Store({ a: 'hello', x: 'unrelated' });

assert.strictEqual(store.get('a'), 'hello');
assert.strictEqual(store.get('x'), 'unrelated'); // warm the cache for an unrelated key

store.delete('a');
assert.strictEqual(store.get('a'), undefined, 'expected 404-equivalent (undefined) after delete, got stale cached value');

// deleting a never-read key must not throw and must not disturb other cache entries
store.delete('never-read');
assert.strictEqual(store.get('x'), 'unrelated', 'unrelated cache entries must survive an unrelated delete');

console.log('OK: cache invalidated on delete, unrelated entries preserved');
