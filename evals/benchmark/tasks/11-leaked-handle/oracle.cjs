const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Do NOT trust a candidate-exported handle counter (e.g. getOpenHandleCount):
// a "fix" could simply make that function always return 0 while still
// leaking real file descriptors. Instead, instrument the real fs.openSync /
// fs.closeSync entry points BEFORE requiring lib.js so every actual open and
// close made through node's fs module is counted independently of whatever
// lib.js claims about its own internal bookkeeping.
const realOpenSync = fs.openSync;
const realCloseSync = fs.closeSync;
let opened = 0;
let closed = 0;
fs.openSync = function instrumentedOpenSync(...args) {
  const fd = realOpenSync.apply(fs, args);
  opened++;
  return fd;
};
fs.closeSync = function instrumentedCloseSync(...args) {
  const result = realCloseSync.apply(fs, args);
  closed++;
  return result;
};

const { processFiles } = require(path.join(process.argv[2], 'lib.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-11-'));
const paths = [];
for (let i = 0; i < 5; i++) {
  const p = path.join(dir, `f${i}.txt`);
  fs.writeFileSync(p, i % 2 === 0 ? 'BAD' : 'good content');
  paths.push(p);
}

const results = processFiles(paths);

assert.strictEqual(
  opened,
  closed,
  `expected every fd opened via fs.openSync (${opened}) to be closed via fs.closeSync (${closed}) ` +
  `— leaked ${opened - closed} handle(s)`,
);
assert.strictEqual(results.filter((r) => !r.ok).length, 3, 'expected the 3 BAD files to still be reported as ok:false');
assert.strictEqual(results.length, 5, 'expected all 5 files to be processed, not aborted early');

for (const p of paths) fs.unlinkSync(p);
fs.rmdirSync(dir);

console.log('OK: no leaked handles, bad files still reported and processing continues');
