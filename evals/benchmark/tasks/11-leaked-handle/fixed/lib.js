const fs = require('fs');

let openHandles = 0;
function _open(p) {
  openHandles++;
  return fs.openSync(p, 'r');
}
function _close(fd) {
  fs.closeSync(fd);
  openHandles--;
}
function getOpenHandleCount() {
  return openHandles;
}

function processFiles(paths) {
  const results = [];
  for (const p of paths) {
    const fd = _open(p);
    try {
      const buf = Buffer.alloc(3);
      fs.readSync(fd, buf, 0, 3, 0);
      if (buf.toString() === 'BAD') {
        results.push({ path: p, ok: false });
        continue;
      }
      results.push({ path: p, ok: true });
    } finally {
      _close(fd);
    }
  }
  return results;
}

module.exports = { processFiles, getOpenHandleCount };
