const { execFileSync } = require('child_process');

function greet(name) {
  return execFileSync('echo', ['hello', name]).toString();
}

module.exports = { greet };
