const assert = require('assert');
const path = require('path');
// A controlled clock makes the rate-limit window independent of host load.
const { mock } = require('node:test');
mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
const { fetchWithRetry } = require(path.join(process.argv[2], 'lib.js'));

(async () => {
  const start = Date.now();
  const RATE_LIMIT_WINDOW_MS = 200;
  let calls = 0;
  const stub = async () => {
    calls++;
    if (Date.now() - start < RATE_LIMIT_WINDOW_MS) return { status: 429 };
    return { status: 200 };
  };

  let settled = false;
  const pending = fetchWithRetry(stub, 25);
  pending.then(() => { settled = true; }, () => { settled = true; });
  for (let ticks = 0; !settled && ticks < 500; ticks++) {
    // Flush async continuations before advancing the next ten milliseconds.
    await new Promise(resolve => setImmediate(resolve));
    if (!settled) mock.timers.tick(10);
  }
  assert.ok(settled, 'retry backoff must finish within 5000ms of simulated time');
  const res = await pending;
  const elapsed = Date.now() - start;

  assert.strictEqual(res.status, 200, `expected eventual success, got status ${res.status}`);
  assert.ok(elapsed >= RATE_LIMIT_WINDOW_MS, `expected the client to actually wait out the rate limit (elapsed=${elapsed}ms)`);
  assert.ok(elapsed < 5000, `expected backoff to be bounded, not an excessive fixed sleep (elapsed=${elapsed}ms)`);
  assert.ok(calls < 25, `expected backoff to reduce attempt count below the naive tight-loop max, got ${calls} calls`);

  console.log(`OK: succeeded after ${elapsed}ms and ${calls} attempts with backoff`);
})().catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => mock.timers.reset());
