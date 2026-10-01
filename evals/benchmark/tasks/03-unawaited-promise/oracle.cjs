const assert = require('assert');
const path = require('path');
const { handleWrite } = require(path.join(process.argv[2], 'lib.js'));

(async () => {
  const failing = () => new Promise((_, reject) => setTimeout(() => reject(new Error('disk full')), 20));
  const failResult = await handleWrite(failing);
  assert.strictEqual(failResult.ok, false, `expected ok:false when writeFn rejects, got ${JSON.stringify(failResult)}`);
  assert.ok(String(failResult.error || '').includes('disk full'), 'expected the rejection message to surface');

  const succeeding = () => new Promise((resolve) => setTimeout(resolve, 5));
  const okResult = await handleWrite(succeeding);
  assert.strictEqual(okResult.ok, true, `expected ok:true when writeFn resolves, got ${JSON.stringify(okResult)}`);

  console.log('OK: write failures surface, successes still report ok');
})().catch((e) => { console.error(e.message); process.exit(1); });
