const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { greet } = require(path.join(process.argv[2], 'lib.js'));

const sentinel = path.join(os.tmpdir(), `bench-04-sentinel-${process.pid}-${Date.now()}`);
try { fs.unlinkSync(sentinel); } catch (_) {}

// classic semicolon injection
greet(`; touch ${sentinel}`);
assert.ok(!fs.existsSync(sentinel), 'semicolon injection executed a second command');

// command-substitution style injection (a "related vector" a narrow fix might miss)
const sentinel2 = `${sentinel}-sub`;
try { fs.unlinkSync(sentinel2); } catch (_) {}
greet(`$(touch ${sentinel2})`);
assert.ok(!fs.existsSync(sentinel2), 'command-substitution injection executed a second command');

// ordinary input must still work
const out = greet('world');
assert.ok(out.includes('world'), `expected greet output to include the name, got: ${out}`);

console.log('OK: no injected commands executed, ordinary input still greeted');
