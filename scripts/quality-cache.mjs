#!/usr/bin/env node
// Publish local advisory reports only after their input fingerprints are rechecked.
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const executable = path.join(root, "node_modules/turbo/bin/turbo");
const cacheRoot = path.join(root, "_state/quality-cache");
const cache = path.join(cacheRoot, "turbo-v2");
const extra = process.argv.slice(2);
const allowed = new Set(["--summarize", "--dry=json"]);
const environment = {
  ...process.env,
  TURBO_TELEMETRY_DISABLED: "1",
  QUALITY_CACHE_RUNTIME: `${process.version}-${process.platform}-${process.arch}`,
};
async function turbo(directory, options) {
  return execute(process.execPath, [executable, "run", "lint:knip:report",
    "--cache=local:rw", "--env-mode=strict", "--no-update-notifier",
    `--cache-dir=${directory}`, ...options], {
    cwd: root, env: environment, maxBuffer: 8 * 1024 * 1024, timeout: 180000,
  });
}
async function fingerprint(directory) {
  const { stdout } = await turbo(directory, ["--dry=json"]);
  const { tasks } = JSON.parse(stdout);
  if (!Array.isArray(tasks) || tasks.length !== 1 || typeof tasks[0].hash !== "string") {
    throw new Error("Expected exactly one fingerprinted quality-report task.");
  }
  return tasks[0].hash;
}
async function main() {
  if (extra.some(argument => !allowed.has(argument))) {
    throw new Error("Supported options: --summarize, --dry=json");
  }
  await mkdir(cache, { recursive: true });
  if (extra.includes("--dry=json")) {
    const result = await turbo(cache, extra);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return;
  }
  const staging = await mkdtemp(path.join(cacheRoot, "staging-"));
  try {
    await cp(cache, staging, { recursive: true });
    const before = await fingerprint(staging);
    const result = await turbo(staging, extra);
    if (before !== await fingerprint(staging)) {
      throw new Error("Inputs changed during the report; output and staged cache discarded. Run again after edits finish.");
    }
    const entries = await readdir(staging, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile())) {
      throw new Error("Unexpected directory or link in the staged task cache.");
    }
    const names = new Set(entries.map(entry => entry.name));
    for (const entry of entries) {
      if (entry.name.endsWith(".tar.zst") && !names.has(entry.name.slice(0, -8) + "-meta.json")) {
        throw new Error("Cache archive has no metadata; staged cache discarded.");
      }
    }
    // Turbo checks for the archive before reading its metadata: publish archives last.
    entries.sort((a, b) => Number(a.name.endsWith(".tar.zst")) - Number(b.name.endsWith(".tar.zst"))
      || a.name.localeCompare(b.name));
    for (const entry of entries) {
      await rename(path.join(staging, entry.name), path.join(cache, entry.name));
    }
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
main().catch(error => {
  if (error.stdout) {
    console.error("Unverified tool failure diagnostics:");
    process.stderr.write(error.stdout);
  }
  console.error(error.message);
  process.exitCode = Number.isInteger(error.code) ? error.code : 2;
});
