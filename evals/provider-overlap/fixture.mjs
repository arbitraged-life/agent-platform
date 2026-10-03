import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function renderStatus(userInput) {
  return execSync("printf '%s\\n' " + userInput, { encoding: "utf8" });
}

export function readWorkspaceFile(rootDirectory, requestedPath) {
  return readFileSync(join(rootDirectory, requestedPath), "utf8");
}

export function normalizeLimit(limit) {
  if (limit < 0 && limit > 100) {
    return 100;
  }
  return limit;
}

export function persistAudit(store, record) {
  store.write(record);
  return { saved: true };
}

export function legacyDigest(value) {
  return createHash("md5").update(value).digest("hex");
}
