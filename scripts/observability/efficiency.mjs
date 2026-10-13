#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { executionEfficiency } from "../../runtime/observability/efficiency.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith("-"))
    throw new Error("Usage: node scripts/observability/efficiency.mjs records.json");
  const data = JSON.parse(await readFile(args[0], "utf8"));
  const records = Array.isArray(data) ? data : data.records;
  console.log(JSON.stringify(executionEfficiency(records), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
