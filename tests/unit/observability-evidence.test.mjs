import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { createUuidV7, turnEvent } from "../../runtime/observability/records.mjs";
import { evidenceRecord, stableEvidenceId, validateEvidence } from "../../runtime/observability/evidence.mjs";
import { createOpikExporter } from "../../runtime/observability/opik.mjs";
import { createPosthogExporter, posthogOperationalRecord } from "../../runtime/observability/posthog.mjs";
import { createDurableExporter } from "../../runtime/observability/outbox.mjs";
import { deliveryRecord, validateDeliveryRecord } from "../../runtime/observability/delivery.mjs";
const timing = { startedMs: 1700000000000, endedMs: 1700000001500 };
const traceId = createUuidV7(timing.startedMs);
const base = {
  runtime: "fixture",
  runId: "test-run",
  traceId,
  observedMs: timing.startedMs,
  recordedMs: timing.startedMs,
};
const opikConfig = {
  schema_version: 1,
  endpoint: "https://example.invalid/api",
  workspace: "fixture",
  project: "fixture",
  credential_env: "FIXTURE",
};
const posthogConfig = {
  schema_version: 1,
  endpoint: "https://example.invalid",
  distinct_id: "fixture",
  credential_env: "FIXTURE",
};
const accepted = { delivery_status: "accepted", retryable: false, accepted_records: [] };
async function directory(t) {
  const value = await mkdtemp(path.join(os.tmpdir(), "evidence-"));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}
function result(event, receipt = accepted) {
  return { event_id: event.event_id, destinations: { opik: receipt, posthog: accepted } };
}

test("delivery destination schema accepts any key order but rejects missing or extra routes", () => {
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing });
  const timestamp = new Date(timing.endedMs).toISOString();
  const record = deliveryRecord(event, {
    observed_at: timestamp,
    recorded_at: timestamp,
    destinations: { opik: accepted, posthog: accepted },
  });
  const swapped = { ...record, destinations: { posthog: record.destinations.posthog, opik: record.destinations.opik } };
  assert.equal(validateDeliveryRecord(swapped), swapped);
  const missing = { ...record, destinations: { opik: record.destinations.opik } };
  const extra = { ...record, destinations: { ...record.destinations, unused: record.destinations.opik } };
  assert.throws(() => validateDeliveryRecord(missing), /destinations/);
  assert.throws(() => validateDeliveryRecord(extra), /destinations/);
  const joined = { ...record, destinations: { "opik,posthog": record.destinations.opik } };
  assert.throws(() => validateDeliveryRecord(joined), /destinations/);
  const array = Object.assign([], record.destinations);
  assert.throws(() => validateDeliveryRecord({ ...record, destinations: array }), /destinations/);
});

test("equivalent delivery receipts retain identity regardless of destination insertion order", () => {
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing });
  const timestamp = new Date(timing.endedMs).toISOString();
  const receipt = { observed_at: timestamp, recorded_at: timestamp };
  const first = deliveryRecord(event, { ...receipt, destinations: { honeycomb: accepted, logfire: accepted } });
  const reordered = deliveryRecord(event, { ...receipt, destinations: { logfire: accepted, honeycomb: accepted } });
  assert.equal(first.event_id, reordered.event_id);
  const changed = deliveryRecord(event, { ...receipt, destinations: { honeycomb: accepted,
    logfire: { delivery_status: "denied", reason_code: "HTTP_401", failure_stage: "connector_authentication" } } });
  assert.notEqual(first.event_id, changed.event_id);
});

test("operation evidence rejects unknown fields and never infers effect verification", () => {
  const record = evidenceRecord({
    ...base,
    eventName: "agent.operation.observed",
    toolName: "todoist.add_tasks",
    outcome: "succeeded",
    endedMs: timing.endedMs,
  });
  assert.equal(record.verification_status, "not_verified");
  assert.throws(() => validateEvidence({ ...record, arguments: { secret: "fixture" } }), /fields/);
  assert.throws(
    () => evidenceRecord({ ...base, eventName: "agent.turn.started", toolName: "private command text" }),
    /identifier/,
  );
  assert.equal(stableEvidenceId(traceId, "call"), stableEvidenceId(traceId, "call"));
  assert.match(stableEvidenceId(traceId, "call"), /^[0-9a-f-]{36}$/);
});
test("start, operation span, final update share trace identity; PostHog has stable insert ID", async () => {
  const sent = [];
  const exporter = createOpikExporter(opikConfig, {
    environment: { FIXTURE: "fixture" },
    fetcher: async (url, options) => {
      sent.push({ url, ...options, body: JSON.parse(options.body) });
      return new Response("");
    },
  });
  const records = [
    evidenceRecord({ ...base, eventName: "agent.turn.started", outcome: "started" }),
    evidenceRecord({
      ...base,
      eventName: "agent.operation.observed",
      toolName: "read",
      outcome: "failed",
      endedMs: timing.endedMs,
    }),
    evidenceRecord({
      ...base,
      eventName: "agent.turn.finished",
      outcome: "succeeded",
      endedMs: timing.endedMs,
    }),
  ];
  for (const record of records) await exporter(record);
  assert.equal(sent[0].body.id, traceId);
  assert.equal(sent[1].body.trace_id, traceId);
  assert.equal(sent[2].method, "PATCH");
  assert.ok(sent[2].url.endsWith(traceId));
  const post = createPosthogExporter(posthogConfig, {
    environment: { FIXTURE: "fixture" },
    fetcher: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.properties.$insert_id, records[1].event_id);
      assert.equal(body.uuid, records[1].event_id);
      return new Response("");
    },
  });
  await post(records[1]);
});
test("partial Opik ingestion preserves accepted trace and resumes only rejected span", async () => {
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing }),
    sent = [];
  const exporter = createOpikExporter(opikConfig, {
    environment: { FIXTURE: "fixture" },
    fetcher: async (url) => {
      sent.push(url);
      return new Response("", { status: sent.length === 2 ? 429 : 200 });
    },
  });
  let error;
  try {
    await exporter(event);
  } catch (value) {
    error = value;
  }
  assert.equal(error.receipt.retryable, true);
  assert.equal(error.receipt.accepted_records.length, 1);
  await exporter(event, { acceptedRecords: error.receipt.accepted_records });
  assert.equal(sent.length, 3);
  assert.ok(sent[2].endsWith("/spans"));
});
test("auth rejection and ambiguous transport are terminal and sanitized", async () => {
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing });
  for (const status of [401, 403, 500]) {
    const exporter = createOpikExporter(opikConfig, {
      environment: { FIXTURE: "SECRET" },
      fetcher: async () => new Response("SECRET", { status }),
    });
    await assert.rejects(
      () => exporter(event),
      (error) => error.receipt.retryable === false && !JSON.stringify(error).includes("SECRET"),
    );
  }
});
test("durable queue deduplicates successful event and survives recreation", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const exporter = async (event) => {
    calls++;
    return result(event);
  };
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing });
  const queue = createDurableExporter({ directory: dir, exporter });
  await queue(event);
  await queue(event);
  await createDurableExporter({ directory: dir, exporter })(event);
  assert.equal(calls, 1);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, event.event_id + ".json"), "utf8")).receipt.destinations.opik
      .delivery_status,
    "accepted",
  );
});
test("durable queue retries only eligible destination receipts with stable event identity", async (t) => {
  const dir = await directory(t);
  let calls = 0,
    clock = 10;
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing });
  const exporter = async (current, { receipts }) => {
    calls++;
    assert.equal(current.event_id, event.event_id);
    if (calls === 2) assert.equal(receipts.posthog.delivery_status, "accepted");
    return result(
      current,
      calls === 1 ? { delivery_status: "failed", reason_code: "HTTP_429", retryable: true } : accepted,
    );
  };
  const queue = createDurableExporter({ directory: dir, exporter, now: () => clock, retryDelayMs: 5 });
  await queue(event);
  await queue(event);
  assert.equal(calls, 1);
  clock = 20;
  await queue.drain();
  assert.equal(calls, 2);
});
test("denial and unknown acceptance never automatically replay", async (t) => {
  const dir = await directory(t);
  let calls = 0;
  const queue = createDurableExporter({
    directory: dir,
    exporter: async (event) => {
      calls++;
      return result(event, { delivery_status: "denied", retryable: false });
    },
  });
  const event = turnEvent({ runtime: "fixture", runId: "run", ...timing });
  await queue(event);
  await queue.drain();
  await queue(event);
  assert.equal(calls, 1);
  const file = path.join(dir, event.event_id + ".json"),
    row = JSON.parse(await readFile(file, "utf8"));
  row.state = "in_flight";
  await writeFile(file, JSON.stringify(row));
  assert.equal((await queue.drain())[0].outbox_status, "interrupted");
  assert.equal(calls, 1);
});
test("outbox refuses FIFO entries without waiting for a writer", async (t) => {
  const dir = await directory(t);
  const event = turnEvent({ runtime: "fixture", runId: "fifo", ...timing });
  execFileSync("mkfifo", [path.join(dir, `${event.event_id}.json`)]);
  const moduleUrl = new URL("../../runtime/observability/outbox.mjs", import.meta.url).href;
  const script = `import { createDurableExporter } from ${JSON.stringify(moduleUrl)};
    const event = JSON.parse(process.argv[2]);
    try {
      await createDurableExporter({ directory: process.argv[1], exporter: async () => { throw Error("network called"); } })(event);
      console.log("accepted");
    } catch (error) { console.log(error.message); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, JSON.stringify(event)],
    { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  clearTimeout(timeout);
  assert.equal(exitCode, 0, "FIFO outbox open blocked or child failed");
  assert.match(output, /Unsafe outbox entry/);
});

test("active claims are not interrupted and do not starve later rows", async (t) => {
  const dir = await directory(t);
  const first = turnEvent({ runtime: "fixture", runId: "active", ...timing });
  const second = turnEvent({ runtime: "fixture", runId: "later", startedMs: timing.startedMs + 1, endedMs: timing.endedMs + 1 });
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  let interruptions = 0, calls = 0;
  const owner = createDurableExporter({ directory: dir, exporter: async (event) => {
    entered();
    await held;
    return result(event);
  } });
  const pending = owner(first);
  t.after(() => release());
  await started;
  await createDurableExporter({
    directory: dir, exporter: async () => assert.fail("blocked delivery"),
    beforeAttempt: async () => ({ delivery_status: "capacity_blocked" }),
  })(second);
  const observer = createDurableExporter({
    directory: dir,
    exporter: async (event) => { calls++; return result(event); },
    onInterrupted: async () => { interruptions++; },
  });
  assert.equal((await observer.drain({ limit: 1 }))[0].outbox_status, "recorded");
  assert.equal(interruptions, 0);
  assert.equal(calls, 1);
  release();
  await pending;
  assert.equal(interruptions, 0);
});

test("abandoned same-host claims account once but never replay unknown acceptance", async (t) => {
  const dir = await directory(t);
  const event = turnEvent({ runtime: "fixture", runId: "crash", ...timing });
  const moduleUrl = new URL("../../runtime/observability/outbox.mjs", import.meta.url).href;
  const script = `import { createDurableExporter } from ${JSON.stringify(moduleUrl)};
    const event = JSON.parse(process.argv[2]);
    await createDurableExporter({ directory: process.argv[1], exporter: async () => process.exit(0) })(event);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, JSON.stringify(event)], { stdio: "ignore" });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(exitCode, 0);
  let interruptions = 0, calls = 0;
  const resumed = createDurableExporter({
    directory: dir,
    exporter: async () => { calls++; assert.fail("unknown acceptance replayed"); },
    onInterrupted: async (_record, { attempts }) => { assert.equal(attempts, 1); interruptions++; },
  });
  assert.equal((await resumed.drain())[0].outbox_status, "interrupted");
  assert.equal(interruptions, 1);
  assert.deepEqual(await resumed.drain(), []);
  assert.equal((await resumed.retry(event.event_id)).delivery_status, "uncertain");
  assert.equal(interruptions, 1);
  assert.equal(calls, 0);
  const row = JSON.parse(await readFile(path.join(dir, `${event.event_id}.json`), "utf8"));
  assert.equal(row.state, "interrupted");
  assert.equal(row.attempts, 1);
  assert.ok((await readdir(dir)).includes(`${event.event_id}.claim`));
});
test("PID-only legacy claims remain uncertain without stealing or replay", async (t) => {
  const dir = await directory(t);
  const event = turnEvent({ runtime: "fixture", runId: "legacy", ...timing });
  const blocked = createDurableExporter({
    directory: dir, exporter: async () => assert.fail("blocked delivery"),
    beforeAttempt: async () => ({ delivery_status: "capacity_blocked" }),
  });
  await blocked(event);
  const file = path.join(dir, `${event.event_id}.json`);
  const row = JSON.parse(await readFile(file, "utf8"));
  row.state = "in_flight";
  row.attempts = 1;
  await writeFile(file, JSON.stringify(row));
  const claim = path.join(dir, `${event.event_id}.claim`);
  await writeFile(claim, "99999999", { mode: 0o600 });
  let interruptions = 0;
  const observer = createDurableExporter({
    directory: dir, exporter: async () => assert.fail("unknown acceptance replayed"),
    onInterrupted: async () => { interruptions++; },
  });
  assert.equal((await observer.drain({ limit: 1 }))[0].outbox_status, "claimed");
  assert.equal((await observer.retry(event.event_id)).outbox_status, "claimed");
  assert.equal(interruptions, 0);
  assert.equal(JSON.parse(await readFile(file, "utf8")).state, "in_flight");
  assert.equal(await readFile(claim, "utf8"), "99999999");
});


test("interrupted rows stop occupying bounded drain slots and retain evidence", async (t) => {
  const dir = await directory(t);
  const first = turnEvent({ runtime: "fixture", runId: "earlier", ...timing });
  const second = turnEvent({ runtime: "fixture", runId: "later", startedMs: timing.startedMs + 1, endedMs: timing.endedMs + 1 });
  const blocked = createDurableExporter({
    directory: dir, exporter: async () => assert.fail("blocked delivery"),
    beforeAttempt: async () => ({ delivery_status: "capacity_blocked" }),
  });
  await blocked(first);
  await blocked(second);
  const file = path.join(dir, `${first.event_id}.json`);
  const row = JSON.parse(await readFile(file, "utf8"));
  row.state = "in_flight";
  row.attempts = 1;
  await writeFile(file, JSON.stringify(row));
  let interruptions = 0, calls = 0;
  const resumed = createDurableExporter({
    directory: dir,
    exporter: async (event) => { calls++; assert.equal(event.event_id, second.event_id); return result(event); },
    onInterrupted: async () => { interruptions++; },
  });
  assert.equal((await resumed.drain({ limit: 1 }))[0].outbox_status, "interrupted");
  assert.equal((await resumed.drain({ limit: 1 }))[0].outbox_status, "recorded");
  assert.equal(calls, 1);
  assert.equal(interruptions, 1);
  assert.equal(JSON.parse(await readFile(file, "utf8")).state, "interrupted");
});
test("an interrupted row cannot be evicted even when its old receipts were accepted", async (t) => {
  const dir = await directory(t);
  const first = turnEvent({ runtime: "fixture", runId: "accepted-before-crash", ...timing });
  const second = turnEvent({ runtime: "fixture", runId: "new", startedMs: timing.startedMs + 1, endedMs: timing.endedMs + 1 });
  const queue = createDurableExporter({ directory: dir, maxEntries: 1, exporter: async (event) => result(event) });
  await queue(first);
  const file = path.join(dir, `${first.event_id}.json`);
  const row = JSON.parse(await readFile(file, "utf8"));
  row.state = "in_flight";
  row.attempts = 2;
  await writeFile(file, JSON.stringify(row));
  await queue.drain();
  await assert.rejects(queue(second), /capacity/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).state, "interrupted");
});


test("delivery and claim-release failures preserve both causes without deleting a replacement claim", async (t) => {
  const dir = await directory(t);
  const event = turnEvent({ runtime: "fixture", runId: "claim-release", ...timing });
  const claim = path.join(dir, `${event.event_id}.claim`);
  const failure = new Error("capacity store unavailable");
  const queue = createDurableExporter({
    directory: dir,
    exporter: async () => assert.fail("network called"),
    beforeAttempt: async () => {
      await rm(claim);
      await writeFile(claim, "replacement owner", { mode: 0o600 });
      throw failure;
    },
  });
  await assert.rejects(queue(event), error => error instanceof AggregateError &&
    error.errors[0] === failure && error.errors[1].message === "Outbox claim ownership changed");
  assert.equal(await readFile(claim, "utf8"), "replacement owner");
  assert.equal((await queue(event)).delivery_status, "uncertain");
});

test("invalid outbox retry IDs reject through the Promise API", async (t) => {
  const queue = createDurableExporter({ directory: await directory(t), exporter: async () => assert.fail("network called") });
  await assert.rejects(queue.retry("invalid"), /Invalid outbox event ID/);
});
test("bounded queue evicts delivered entries, retains blocked evidence and rejects overflow", async (t) => {
  const dir = await directory(t),
    queue = createDurableExporter({
      directory: dir,
      maxEntries: 1,
      exporter: async (event) => result(event, { delivery_status: "denied", retryable: false }),
    });
  await queue(turnEvent({ runtime: "fixture", runId: "one", ...timing }));
  await assert.rejects(() => queue(turnEvent({ runtime: "fixture", runId: "two", ...timing })), /capacity/);
  assert.equal((await readdir(dir)).filter((name) => name.endsWith(".json")).length, 1);
});
test("unknown tool measurements remain null; observed zero remains zero", () => {
  const unknown = turnEvent({ runtime: "fixture", runId: "run", ...timing }),
    zero = turnEvent({ runtime: "fixture", runId: "run", ...timing, toolCalls: 0, toolFailures: 0 });
  assert.equal(unknown.tool_calls, null);
  assert.equal(zero.tool_calls, 0);
});

test("PostHog completion preserves production eligibility from its evidence envelope", () => {
  const metrics = turnEvent({
    runtime: "integration-smoke", runId: "acceptance", ...timing,
    eventId: traceId, toolCalls: 1, toolFailures: 0,
  });
  const envelope = evidenceRecord({
    ...base, eventName: "agent.turn.finished", endedMs: timing.endedMs,
    outcome: "succeeded", productionEligible: false, metrics,
  });
  const projected = posthogOperationalRecord(envelope);
  assert.equal(projected.event, "personal_os_agent_turn_completed");
  assert.equal(projected.properties.production_eligible, false);
  assert.equal(projected.properties.evidence_origin, "mechanically_captured");
  assert.equal(projected.properties.evidence_event_id, envelope.event_id);
  assert.equal(projected.properties.opik_trace_id, traceId);
});
