#!/usr/bin/env node
// This local trial never reads or writes a remote cache.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const executable = fileURLToPath(new URL("../node_modules/turbo/bin/turbo", import.meta.url));
const allowed = new Set(["--summarize", "--dry=json"]);
const extra = process.argv.slice(2);
if (extra.some(argument => !allowed.has(argument))) {
  console.error("Supported options: --summarize, --dry=json");
  process.exit(2);
}
const child = spawn(process.execPath, [executable, "run", "lint:knip:report", "--cache=local:rw", "--env-mode=strict", "--no-update-notifier", ...extra], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", QUALITY_CACHE_RUNTIME: `${process.version}-${process.platform}-${process.arch}` },
});
child.on("error", error => { console.error(error.message); process.exitCode = 2; });
child.on("exit", (code, signal) => {
  if (process.exitCode === undefined) process.exitCode = signal ? 1 : (code ?? 2);
});
