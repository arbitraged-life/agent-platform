#!/usr/bin/env node
// Offline fixture preparation and bounded grading of trusted candidate code.
// Grading executes JavaScript; it is not a security sandbox.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TASKS_ROOT = path.join(__dirname, 'tasks');

function listTaskIds() {
  return readdirSync(TASKS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function taskDir(id) {
  if (!listTaskIds().includes(id)) {
    throw new Error(`unknown task id: ${id} (known: ${listTaskIds().join(', ')})`);
  }
  return path.join(TASKS_ROOT, id);
}

// Each subprocess owns a process group and temporary directory. Kill the whole
// group before cleanup, including descendants that outlive their parent.
async function runBounded(command, args) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'platform-benchmark-'));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
      });
      const chunks = [];
      let outputBytes = 0;
      let failure;
      let groupKilled = false;
      const kill = () => {
        if (!child.pid || groupKilled) return;
        groupKilled = true;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failure = error.message; }
      };
      const signals = ['SIGINT', 'SIGTERM'];
      const interrupted = (signal) => {
        failure = `interrupted by ${signal}`;
        process.exitCode = signal === 'SIGINT' ? 130 : 143;
        kill();
      };
      const handlers = signals.map(signal => () => interrupted(signal));
      signals.forEach((signal, index) => process.on(signal, handlers[index]));
      const timer = setTimeout(() => { failure = 'grading/setup timed out after 5000ms'; kill(); }, 5000);
      const collect = (data) => {
        if (failure) return;
        if (outputBytes + data.length > 65536) {
          failure = 'grading/setup output exceeded 65536 bytes';
          kill();
        } else { chunks.push(data); outputBytes += data.length; }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.on('error', (error) => { failure = error.message; });
      child.on('exit', kill);
      child.on('close', (code) => {
        clearTimeout(timer);
        signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
        kill();
        const output = Buffer.concat(chunks).toString('utf8');
        if (failure || code !== 0) reject(new Error(failure || output.trim() || `process exited ${code}`));
        else resolve(output);
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runSetup(id, workdir) {
  await runBounded('bash', [path.join(taskDir(id), 'setup.sh'), path.resolve(workdir)]);
}

async function runOracle(id, workdir) {
  const dir = taskDir(id);
  try {
    await runBounded(process.execPath, [path.join(dir, 'oracle.cjs'), path.resolve(workdir)]);
    return { pass: true, reason: null };
  } catch (error) {
    return { pass: false, reason: error.message };
  }
}

// Resolves `p` to an absolute, symlink-free path even when `p` (or a
// trailing portion of it) does not exist yet: realpath-resolves the longest
// existing ancestor, then rejoins the not-yet-created remainder untouched.
function canonicalize(p) {
  let resolved = path.resolve(p);
  const remainder = [];
  while (!existsSync(resolved)) {
    const parent = path.dirname(resolved);
    if (parent === resolved) break; // reached filesystem root
    remainder.unshift(path.basename(resolved));
    resolved = parent;
  }
  const real = realpathSync(resolved);
  return remainder.length > 0 ? path.join(real, ...remainder) : real;
}

function cmdList() {
  for (const id of listTaskIds()) console.log(id);
}

async function cmdTask(id, workdir, force = false) {
  // Guard the caller-owned scratch contract. `--workdir` is an arbitrary
  // path and setup.sh writes fixture files straight into it, so pointing
  // this at a live checkout would scatter fixtures through real work.
  //
  // Containment is checked against the CANONICAL (symlink-resolved) path,
  // not the raw string: a symlink that lives outside the repo but resolves
  // to a path inside it would otherwise sail past a string-prefix check on
  // the literal --workdir argument, then setup.sh would follow the symlink
  // and write fixtures straight into the checkout anyway.
  const resolved = canonicalize(workdir);
  const repoRoot = realpathSync(path.resolve(__dirname, '../..'));
  // Inside this repo is refused UNCONDITIONALLY -- --force does not reach it.
  // An empty directory nested in the checkout still passes the emptiness test
  // below, and would then be filled with untracked fixture files that show up
  // in `git status` and can be committed by accident. There is no legitimate
  // reason to materialize a fixture inside the repo that ships it.
  if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) {
    throw new Error(
      `--workdir must be outside this repository (${repoRoot}); got ${resolved}. ` +
      `Fixtures are scratch data and must never land in the checkout.`,
    );
  }
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`--workdir exists and is not a directory: ${resolved}`);
    }
    const entries = readdirSync(resolved).filter((e) => e !== '.DS_Store');
    if (entries.length > 0 && !force) {
      throw new Error(
        `--workdir is not empty: ${resolved} (${entries.length} entries). ` +
        `Refusing to write fixture files into an existing directory. ` +
        `Use an empty/new path, or pass --force to overwrite deliberately.`,
      );
    }
  }
  await runSetup(id, resolved);
  const prompt = readFileSync(path.join(taskDir(id), 'prompt.md'), 'utf8');
  console.log(`# Task ${id} materialized at ${workdir}\n`);
  console.log(prompt);
}

async function cmdGrade(id, workdir) {
  const { pass, reason } = await runOracle(id, workdir);
  console.log(pass ? `PASS ${id}` : `FAIL ${id}: ${reason}`);
  process.exitCode ||= pass ? 0 : 1;
}

async function cmdGradeAll(root) {
  const ids = listTaskIds();
  const results = [];
  for (const id of ids) {
    const workdir = path.join(root, id);
    if (!existsSync(workdir)) {
      results.push({ id, pass: false, reason: 'no worked directory found under root' });
      continue;
    }
    const { pass, reason } = await runOracle(id, workdir);
    results.push({ id, pass, reason: pass ? null : reason });
    if (process.exitCode >= 128) break;
  }

  const passCount = results.filter((r) => r.pass).length;
  console.log('Task'.padEnd(32) + 'Result');
  console.log('-'.repeat(48));
  for (const r of results) {
    console.log(r.id.padEnd(32) + (r.pass ? 'PASS' : `FAIL: ${r.reason}`));
  }
  console.log('-'.repeat(48));
  console.log(`${passCount}/${results.length} passed`);

  // Stable machine-readable summary for external report consumers.
  console.log(JSON.stringify({
    type: 'benchmark-grade-all',
    root,
    total: results.length,
    passed: passCount,
    results: results.map((r) => ({ id: r.id, pass: r.pass, reason: r.reason })),
  }));

  process.exitCode ||= passCount === results.length ? 0 : 1;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') args.list = true;
    else if (a === '--task') args.task = argv[++i];
    else if (a === '--workdir') args.workdir = argv[++i];
    else if (a === '--grade') args.grade = argv[++i];
    else if (a === '--grade-all') args.gradeAll = argv[++i];
    else if (a === '--force') args.force = true;
    else throw new Error(`unrecognized argument: ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    cmdList();
    return;
  }
  if (args.gradeAll !== undefined) {
    await cmdGradeAll(args.gradeAll);
    return;
  }
  if (args.task && args.workdir) {
    await cmdTask(args.task, args.workdir, Boolean(args.force));
    return;
  }
  if (args.task && args.grade) {
    await cmdGrade(args.task, args.grade);
    return;
  }

  console.error(`usage:
  node evals/benchmark/run.mjs --list
  node evals/benchmark/run.mjs --task <id> --workdir <path>
  node evals/benchmark/run.mjs --task <id> --grade <path>
  node evals/benchmark/run.mjs --grade-all <root>`);
  process.exitCode = 2;
}

try {
  await main();
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exitCode ||= 1;
}
