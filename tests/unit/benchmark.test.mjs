import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readdirSync,
  mkdtempSync,
  rmSync,
  cpSync,
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const HARNESS_ROOT = join(import.meta.dirname, "..", "..");
const BENCHMARK_ROOT = join(HARNESS_ROOT, "evals", "benchmark");
const TASKS_ROOT = join(BENCHMARK_ROOT, "tasks");
const RUNNER = join(BENCHMARK_ROOT, "run.mjs");

function taskIds() {
  return readdirSync(TASKS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function tasksWithReferenceFix() {
  return taskIds().filter((id) => existsSync(join(TASKS_ROOT, id, "fixed", "lib.js")));
}

function runNode(args) {
  try {
    const output = execFileSync("node", args, { encoding: "utf8", timeout: 20000 });
    return { code: 0, output };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

function setupTask(id, dest) {
  execFileSync("bash", [join(TASKS_ROOT, id, "setup.sh"), dest], { timeout: 10000 });
}

function gradeTask(id, workdir) {
  const result = runNode([RUNNER, '--task', id, '--grade', workdir]);
  return { pass: result.code === 0, reason: result.output };
}

test("run.mjs --list prints exactly the 12 spec'd task ids", () => {
  const result = runNode([RUNNER, "--list"]);
  assert.equal(result.code, 0, result.output);
  const ids = result.output.trim().split("\n").filter(Boolean);
  assert.equal(ids.length, 12, `expected 12 task ids, got ${ids.length}: ${ids.join(", ")}`);
  assert.deepEqual(ids, taskIds());
});

test("run.mjs exits non-zero on an unknown task id", () => {
  const dest = mkdtempSync(join(tmpdir(), `bench-unknown-${randomUUID()}-`));
  try {
    const result = runNode([RUNNER, "--task", "does-not-exist", "--workdir", dest], { timeout: 10000 });
    assert.notEqual(result.code, 0);
    assert.match(result.output, /unknown task id/);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("run.mjs refuses a --workdir inside the repo, even an empty one, even with --force", () => {
  const inside = join(HARNESS_ROOT, "tests", ".artifacts", `bench-inside-${randomUUID()}`);
  try {
    const plain = runNode([RUNNER, "--task", taskIds()[0], "--workdir", inside]);
    assert.notEqual(plain.code, 0);
    assert.match(plain.output, /must be outside this repository/);

    // --force is deliberately NOT an escape hatch for repo containment:
    // untracked fixtures inside the checkout can be committed by accident.
    const forced = runNode([RUNNER, "--task", taskIds()[0], "--workdir", inside, "--force"]);
    assert.notEqual(forced.code, 0);
    assert.match(forced.output, /must be outside this repository/);
    assert.ok(!existsSync(inside), "must not have created the directory it refused");
  } finally {
    rmSync(inside, { recursive: true, force: true });
  }
});

test("run.mjs refuses a --workdir that is a symlink resolving inside the repo, even with --force", () => {
  const insideTarget = join(HARNESS_ROOT, "tests", ".artifacts", `bench-symlink-target-${randomUUID()}`);
  const symlinkPath = join(tmpdir(), `bench-symlink-${randomUUID()}`);
  mkdirSync(insideTarget, { recursive: true });
  try {
    symlinkSync(insideTarget, symlinkPath, "dir");

    const plain = runNode([RUNNER, "--task", taskIds()[0], "--workdir", symlinkPath]);
    assert.notEqual(plain.code, 0);
    assert.match(plain.output, /must be outside this repository/);

    const forced = runNode([RUNNER, "--task", taskIds()[0], "--workdir", symlinkPath, "--force"]);
    assert.notEqual(forced.code, 0);
    assert.match(forced.output, /must be outside this repository/);
    assert.equal(readdirSync(insideTarget).length, 0, "must not have written fixtures through the symlink");
  } finally {
    rmSync(symlinkPath, { force: true });
    rmSync(insideTarget, { recursive: true, force: true });
  }
});

test("run.mjs refuses a non-empty --workdir unless --force is passed", () => {
  const dest = mkdtempSync(join(tmpdir(), `bench-nonempty-${randomUUID()}-`));
  const id = taskIds()[0];
  try {
    // First setup into an empty dir succeeds and leaves content behind.
    const first = runNode([RUNNER, "--task", id, "--workdir", dest], { timeout: 10000 });
    assert.equal(first.code, 0, first.output);
    assert.ok(readdirSync(dest).length > 0, "setup should have written fixture files");

    // Second run must refuse, because the directory now has content.
    const second = runNode([RUNNER, "--task", id, "--workdir", dest], { timeout: 10000 });
    assert.notEqual(second.code, 0);
    assert.match(second.output, /not empty/);

    // --force is the deliberate opt-out and must actually be wired through.
    const forced = runNode([RUNNER, "--task", id, "--workdir", dest, "--force"]);
    assert.equal(forced.code, 0, `--force must be reachable, got: ${forced.output}`);
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("every task's oracle genuinely fails against its own seeded-bug fixture", async (t) => {
  for (const id of taskIds()) {
    await t.test(id, () => {
      const dest = mkdtempSync(join(tmpdir(), `bench-${id}-${randomUUID()}-`));
      try {
        setupTask(id, dest);
        assert.ok(
          existsSync(join(dest, "lib.js")),
          `setup.sh for ${id} did not materialize lib.js`,
        );
        const { pass, reason } = gradeTask(id, dest);
        assert.equal(
          pass,
          false,
          `oracle for ${id} passed against the UNFIXED fixture — the seeded bug is not being detected`,
        );
        assert.ok(reason && reason.length > 0, `oracle for ${id} gave no failure reason`);
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });
  }
});

test("known-correct reference fixes make their oracle pass", async (t) => {
  const withFix = tasksWithReferenceFix();
  assert.ok(
    withFix.length >= 4,
    `expected at least 4 tasks with a reference fix, found ${withFix.length}: ${withFix.join(", ")}`,
  );

  for (const id of withFix) {
    await t.test(id, () => {
      const dest = mkdtempSync(join(tmpdir(), `bench-fixed-${id}-${randomUUID()}-`));
      try {
        setupTask(id, dest);
        cpSync(join(TASKS_ROOT, id, "fixed", "lib.js"), join(dest, "lib.js"));
        const { pass, reason } = gradeTask(id, dest);
        assert.equal(pass, true, `oracle for ${id} rejected the known-correct reference fix: ${reason}`);
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });
  }
});

test("task 11 oracle rejects a leak disguised by a spoofed getOpenHandleCount", () => {
  const id = "11-leaked-handle";
  const dest = mkdtempSync(join(tmpdir(), `bench-spoof-${randomUUID()}-`));
  try {
    setupTask(id, dest);
    const original = readFileSync(join(dest, "lib.js"), "utf8");
    // Same seeded leak, but getOpenHandleCount is hardcoded to lie and claim
    // zero open handles regardless of reality. An oracle that trusts the
    // candidate-exported counter would be fooled by this; one that
    // independently instruments fs.openSync/closeSync must not be.
    const spoofed = original.replace(
      "function getOpenHandleCount() {\n  return openHandles;\n}",
      "function getOpenHandleCount() {\n  return 0;\n}",
    );
    assert.notEqual(spoofed, original, "expected the replace() to actually match lib.js's getOpenHandleCount");
    writeFileSync(join(dest, "lib.js"), spoofed);

    const { pass, reason } = gradeTask(id, dest);
    assert.equal(pass, false, "oracle for 11-leaked-handle was fooled by a spoofed getOpenHandleCount");
    assert.ok(reason && reason.length > 0, "oracle for 11-leaked-handle gave no failure reason");
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
});

test("run.mjs --grade-all reports the reference-fixed tasks as PASS and the rest as FAIL", () => {
  const root = mkdtempSync(join(tmpdir(), `bench-grade-all-${randomUUID()}-`));
  try {
    const withFix = tasksWithReferenceFix();
    for (const id of taskIds()) {
      const dest = join(root, id);
      setupTask(id, dest);
      if (withFix.includes(id)) {
        cpSync(join(TASKS_ROOT, id, "fixed", "lib.js"), join(dest, "lib.js"));
      }
    }

    const result = runNode([RUNNER, "--grade-all", root]);
    const jsonLine = result.output
      .trim()
      .split("\n")
      .find((line) => line.startsWith("{"));
    assert.ok(jsonLine, `expected a machine-readable JSON summary line, got: ${result.output}`);
    const summary = JSON.parse(jsonLine);

    assert.equal(summary.total, 12);
    assert.equal(summary.passed, withFix.length);
    for (const r of summary.results) {
      assert.equal(r.pass, withFix.includes(r.id), `expected ${r.id} pass=${withFix.includes(r.id)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("task IDs reject traversal even when a directory exists", () => {
  const result = runNode([RUNNER, '--task', '..', '--grade', tmpdir()]);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /unknown task id/);
});

test("grading kills hanging candidates and cleans its temporary files", () => {
  const dest = mkdtempSync(join(tmpdir(), 'bench-timeout-'));
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('platform-benchmark-')));
  try {
    writeFileSync(join(dest, 'lib.js'), 'while (true) {}');
    const result = runNode([RUNNER, '--task', taskIds()[0], '--grade', dest]);
    assert.notEqual(result.code, 0);
    assert.match(result.output, /timed out/);
    const remaining = readdirSync(tmpdir()).filter(name => name.startsWith('platform-benchmark-') && !before.has(name));
    assert.deepEqual(remaining, []);
  } finally { rmSync(dest, { recursive: true, force: true }); }
});

test("failed oracles clean their temporary files", () => {
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith('platform-benchmark-')));
  for (const id of taskIds().filter(name => /^(04|06|11)-/.test(name))) {
    const dest = mkdtempSync(join(tmpdir(), 'bench-cleanup-'));
    try { setupTask(id, dest); assert.equal(gradeTask(id, dest).pass, false); }
    finally { rmSync(dest, { recursive: true, force: true }); }
  }
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('platform-benchmark-') && !before.has(name)), []);
});

test("relative grade paths resolve from the caller directory", () => {
  const id = tasksWithReferenceFix()[0];
  const dest = mkdtempSync(join(tmpdir(), 'bench-relative-'));
  try {
    cpSync(join(TASKS_ROOT, id, 'fixed', 'lib.js'), join(dest, 'lib.js'));
    assert.equal(gradeTask(id, relative(process.cwd(), dest)).pass, true);
  } finally { rmSync(dest, { recursive: true, force: true }); }
});


test("backoff oracle accepts an asynchronous bounded retry", () => {
  const id = taskIds().find(name => name.startsWith('09-'));
  const dest = mkdtempSync(join(tmpdir(), 'bench-clock-'));
  try {
    writeFileSync(join(dest, 'lib.js'), `
      exports.fetchWithRetry = async (fetch, max) => {
        for (let i = 0; i < max; i++) {
          const result = await fetch();
          if (result.status !== 429) return result;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('exhausted');
      };
    `);
    const result = gradeTask(id, dest);
    assert.equal(result.pass, true, result.reason);
  } finally { rmSync(dest, { recursive: true, force: true }); }
});

test("cancellation terminates descendants and cleans owned temporary state", async () => {
  const dest = mkdtempSync(join(tmpdir(), 'bench-cancel-'));
  let child;
  let ready;
  try {
    const marker = join(dest, 'ready.json');
    writeFileSync(join(dest, 'lib.js'), `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(marker)},
        JSON.stringify({ pid: child.pid, temporary: require('node:os').tmpdir() }));
      while (true) {}
    `);
    child = spawn(process.execPath, [RUNNER, '--task', taskIds()[0], '--grade', dest], { stdio: 'ignore' });
    const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(marker), 'candidate must report readiness');
    ready = JSON.parse(readFileSync(marker, 'utf8'));
    child.kill('SIGTERM');
    const result = await closed;
    assert.equal(result.code, 143);
    assert.equal(existsSync(ready.temporary), false);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(ready.pid, 0); await new Promise(resolve => setTimeout(resolve, 10)); }
      catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false, 'descendant must not survive cancellation');
  } finally {
    child?.kill('SIGKILL');
    if (ready) { try { process.kill(ready.pid, 'SIGKILL'); } catch {} }
    rmSync(dest, { recursive: true, force: true });
  }
});
