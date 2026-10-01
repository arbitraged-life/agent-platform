const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendLine } = require(path.join(process.argv[2], 'lib.js'));

const file = path.join(os.tmpdir(), `bench-06-${process.pid}-${Date.now()}.jsonl`);
try { fs.unlinkSync(file); } catch (_) {}

const N = 20;

(async () => {
  await Promise.all(Array.from({ length: N }, (_, i) => appendLine(file, { i, tag: 'x'.repeat(10) })));

  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);

  for (const line of lines) {
    JSON.parse(line); // throws (and fails the oracle) on any interleaved/partial line
  }
  assert.strictEqual(lines.length, N, `expected ${N} lines, got ${lines.length} (lost or merged writes)`);

  fs.unlinkSync(file);
  console.log('OK: all concurrent appends produced valid, complete JSON lines');
})().catch((e) => { console.error(e.message); process.exit(1); });
