import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createAppsScriptObservability } from "../../runtime/observability/apps-script.mjs";

function fixture(settings = {}, respond = () => ({ code: 200, body: "{}" })) {
  const properties = new Map(Object.entries(settings));
  const calls = [];
  let clock = 1730000000000;
  const gas = {
    Utilities: {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      computeDigest: (_algorithm, value) => [...createHash("sha256").update(value).digest()].map((byte) => byte > 127 ? byte - 256 : byte),
      newBlob: (value) => ({ getBytes: () => Array.isArray(value) ? value : [...Buffer.from(value)] }),
      sleep: () => {},
      getUuid: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    },
    PropertiesService: { getScriptProperties: () => ({
      getKeys: () => [...properties.keys()],
      getProperty: (key) => properties.get(key) ?? null,
      setProperty: (key, value) => { properties.set(key, String(value)); },
      deleteProperty: (key) => { properties.delete(key); }
    }) },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    UrlFetchApp: { fetch: (url, args) => {
      calls.push({ url, args });
      const answer = respond(url, args, calls.length);
      if (answer instanceof Error) throw answer;
      return { getResponseCode: () => answer.code, getContentText: () => answer.body ?? "",
        getContent: () => answer.bytes ?? [] };
    } },
    now: () => clock
  };
  return { properties, calls, gas, setNow: (time) => { clock = time; }, capture: createAppsScriptObservability(gas).capture };
}
const TARGET = {
  AGENT_TELEMETRY_MODE: "mirror", HONEYCOMB_OTLP_ENDPOINT: "https://api.honeycomb.io",
  LOGFIRE_OTLP_ENDPOINT: "https://logfire-us.pydantic.dev", HONEYCOMB_API_KEY: "secret-h",
  LOGFIRE_WRITE_TOKEN: "secret-l", HONEYCOMB_ALLOWANCE: "10", LOGFIRE_ALLOWANCE: "10",
  HONEYCOMB_OTHER_USAGE: "0", LOGFIRE_OTHER_USAGE: "0",
  HONEYCOMB_PERIOD_START: "2024-10-01T00:00:00.000Z", LOGFIRE_PERIOD_START: "2024-10-17T06:00:00.000Z",
  HONEYCOMB_PERIOD_END: "2024-11-01T00:00:00.000Z", LOGFIRE_PERIOD_END: "2024-11-17T06:00:00.000Z"
};
const GENERATION = { traceId: "classifier-1", sessionId: "session-1", provider: "google", model: "gemini",
  startedMs: 1730000000000, endedMs: 1730000000040, inputTokens: 7, outputTokens: 3,
  input: "SECRET_PROMPT", output: "SECRET_RESPONSE", error: "secret-error" };

 test("complete real generation forms one root span with stable identity and sanitized aggregate usage", () => {
  const f = fixture(TARGET);
  assert.equal(f.capture(GENERATION), true);
  assert.equal(f.calls.length, 2);
  const body = JSON.parse(f.calls[0].args.payload);
  const span = body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.match(span.traceId, /^[a-f0-9]{32}$/);
  assert.match(span.spanId, /^[a-f0-9]{16}$/);
  const receipt = JSON.parse([...f.properties.entries()].find(([key]) => key.startsWith("AGENT_TELEMETRY_TRACE_"))[1]);
  assert.equal(receipt.id.replaceAll("-", ""), span.traceId);
  assert.equal(span.spanId, createHash("sha256")
    .update(`agent-platform:otlp:span:${receipt.id}:`).digest("hex").slice(0, 16));
  assert.equal(span.parentSpanId, undefined);
  assert.equal(span.startTimeUnixNano, String(GENERATION.startedMs * 1e6));
  assert.ok(Buffer.from(f.calls[1].args.payload).includes(Buffer.from(span.traceId, "hex")));
  assert.ok(Buffer.from(f.calls[1].args.payload).includes(Buffer.from(span.spanId, "hex")));
  const attrs = Object.fromEntries(span.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
  assert.equal(attrs["gen_ai.usage.input_tokens"], "7");
  assert.equal(attrs["gen_ai.usage.output_tokens"], "3");
  assert.equal(attrs["gen_ai.usage.total_tokens"], undefined);
  assert.equal(attrs["gen_ai.operation.name"], "chat");
  assert.equal(attrs["agent.outcome"], "failed");
  assert.doesNotMatch(JSON.stringify(f.calls.map((call) => call.args.payload)), /SECRET_PROMPT|SECRET_RESPONSE|secret-error|secret-h|secret-l/);
  assert.equal(f.capture(GENERATION), true);
  assert.equal(f.calls.length, 2);
  const replay = fixture(TARGET);
  assert.equal(replay.capture(GENERATION), true);
  assert.equal(JSON.parse(replay.calls[0].args.payload).resourceSpans[0].scopeSpans[0].spans[0].traceId, span.traceId);
 });

test("provider-reported total stays authoritative rather than summing input and output", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture({ ...GENERATION, totalTokens: 17 }), true);
  const span = JSON.parse(f.calls[0].args.payload).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.attributes.find(({ key }) => key === "gen_ai.usage.total_tokens").value.intValue, "17");
});

test("credential-shaped metadata is omitted or rejected before durable reservation", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" });
  const credential = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
  assert.equal(f.capture({ ...GENERATION, provider: credential, model: credential }), true);
  const payload = JSON.stringify(f.calls[0].args.payload);
  assert.doesNotMatch(payload, /ghp_1234567890abcdefghijklmnopqrstuvwxyz/);
  assert.throws(() => f.capture({ ...GENERATION, traceId: "other",
    operations: [{ id: "tool-1", name: credential }] }), /Invalid observed operation/);
});

test("independent non-monthly billing periods do not merge reservations or baselines", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "1",
    LOGFIRE_ALLOWANCE: "0", HONEYCOMB_OTHER_USAGE: "0" });
  assert.equal(f.capture(GENERATION), true);
  const first = [...f.properties.keys()].find((key) => key.startsWith("AGENT_TELEMETRY_USED_"));
  f.properties.set("HONEYCOMB_PERIOD_START", "2024-11-01T00:00:00.000Z");
  f.properties.set("HONEYCOMB_PERIOD_END", "2024-12-01T00:00:00.000Z");
  f.setNow(Date.UTC(2024, 10, 2));
  assert.equal(f.capture({ ...GENERATION, traceId: "other-period" }), true);
  const counters = [...f.properties.keys()].filter((key) => key.startsWith("AGENT_TELEMETRY_USED_"));
  assert.equal(counters.length, 2);
  assert.ok(counters.includes(first));
});
test("overlapping reset revisions cannot replenish a previously reserved free period", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture(GENERATION), true);
  f.properties.set("HONEYCOMB_PERIOD_START", "2024-10-16T00:00:00.000Z");
  f.properties.set("HONEYCOMB_PERIOD_END", "2024-11-16T00:00:00.000Z");
  assert.throws(() => f.capture({ ...GENERATION, traceId: "overlap" }), /overlapping billing period/);
  assert.equal(f.calls.length, 1);
});

test("expired billing settings retain a new trace as pending without network activity", () => {
  const f = fixture(TARGET);
  f.setNow(Date.UTC(2024, 11, 2));
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 0);
  const pending = JSON.parse([...f.properties.entries()].find(([key]) =>
    key.startsWith("AGENT_TELEMETRY_TRACE_"))[1]);
  assert.equal(pending.status, "capacity_blocked");
  for (const sink of ["HONEYCOMB", "LOGFIRE"]) {
    f.properties.set(`${sink}_PERIOD_START`, "2024-12-01T00:00:00.000Z");
    f.properties.set(`${sink}_PERIOD_END`, "2025-01-01T00:00:00.000Z");
  }
  assert.equal(createAppsScriptObservability(f.gas).drain(), 1);
  assert.equal(f.calls.length, 2);
});

test("bounded pending queue retains blocked traces and rejects new admissions explicitly", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split",
    HONEYCOMB_ALLOWANCE: "0", LOGFIRE_ALLOWANCE: "0" });
  for (let i = 0; i < 64; i++) assert.equal(f.capture({ ...GENERATION, traceId: `blocked-${i}` }), false);
  assert.throws(() => f.capture({ ...GENERATION, traceId: "blocked-64" }), /buffer capacity exhausted/);
  assert.equal(f.calls.length, 0);
  assert.equal([...f.properties.keys()].filter((key) => key.startsWith("AGENT_TELEMETRY_TRACE_")).length, 64);
});


 test("missing real timing emits associated log, not fabricated span or child", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture({ ...GENERATION, startedMs: undefined, endedMs: undefined }), true);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /\/v1\/logs$/);
  const body = JSON.parse(f.calls[0].args.payload);
  const record = body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.match(record.traceId, /^[a-f0-9]{32}$/);
  assert.equal(record.spanId, undefined);
 });

test("unknown timing Logfire protobuf carries trace identity without a nonexistent span", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "0" });
  assert.equal(f.capture({ ...GENERATION, startedMs: undefined, endedMs: undefined }), true);
  const receipt = JSON.parse([...f.properties.entries()].find(([key]) =>
    key.startsWith("AGENT_TELEMETRY_TRACE_"))[1]);
  const bytes = Buffer.from(f.calls[0].args.payload);
  assert.ok(bytes.includes(Buffer.from(receipt.id.replaceAll("-", ""), "hex")));
  assert.equal(bytes.includes(Buffer.from(createHash("sha256")
    .update(`agent-platform:otlp:span:${receipt.id}:`).digest("hex").slice(0, 16), "hex")), false);
});

 test("missing target credentials fail closed without initiating export or leaking properties", () => {
  const f = fixture({ ...TARGET, LOGFIRE_WRITE_TOKEN: "" });
  assert.throws(() => f.capture(GENERATION), /telemetry configuration/i);
  assert.equal(f.calls.length, 0);
 });

 test("independent durable receipts never resend accepted peer after ambiguous failure", () => {
  const f = fixture(TARGET, (url) => url.includes("logfire") ? new Error("network secret") : { code: 200, body: "{}" });
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 2);
  const receipt = [...f.properties.entries()].find(([key]) => key.startsWith("AGENT_TELEMETRY_TRACE_"))[1];
  assert.match(receipt, /accepted/);
  assert.match(receipt, /uncertain/);
  assert.doesNotMatch(receipt, /secret/);
  const counts = [...f.properties.entries()].filter(([key]) => key.startsWith("AGENT_TELEMETRY_COUNTS_"))
    .map(([, value]) => JSON.parse(value));
  assert.deepEqual(counts.map(({ observed, attempted, accepted, failed, dropped, uncertain }) =>
    [observed, attempted, accepted, failed, dropped, uncertain]), [[1, 1, 1, 0, 0, 0], [1, 1, 0, 0, 0, 1]]);
 });
 test("mirror never sends one peer when the other lacks entire trace capacity", () => {
  const f = fixture({ ...TARGET, HONEYCOMB_ALLOWANCE: "1", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 0);
  assert.equal([...f.properties.keys()].filter((key) => key.startsWith("AGENT_TELEMETRY_TRACE_")).length, 1);
  const pending = JSON.parse([...f.properties.entries()].find(([key]) => key.startsWith("AGENT_TELEMETRY_TRACE_"))[1]);
  assert.equal(pending.status, "capacity_blocked");
  const usage = [...f.properties.entries()].filter(([key]) => key.startsWith("AGENT_TELEMETRY_COUNTS_"));
  assert.equal(usage.length, 2);
  assert.ok(usage.every(([, value]) => JSON.parse(value).observed === 1));
  assert.ok(usage.every(([, value]) => JSON.parse(value).blocked === 1));
  assert.equal(f.capture(GENERATION), false);
  assert.ok(usage.every(([key]) => JSON.parse(f.properties.get(key)).blocked === 1));
  f.properties.set("LOGFIRE_ALLOWANCE", "1");
  assert.equal(createAppsScriptObservability(f.gas).drain(), 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.capture(GENERATION), true);
  assert.equal(f.calls.length, 2);
 });


 test("whole trace capacity and persistent split assignment never use a paid overage", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "0", LOGFIRE_ALLOWANCE: "1" });
  assert.equal(f.capture(GENERATION), true);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].url, /logfire/);
  assert.equal(f.capture({ ...GENERATION, traceId: "classifier-2" }), false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.capture(GENERATION), true);
  assert.equal(f.calls.length, 1);
 });

test("OTLP JSON partialSuccess with only an error message defaults missing rejected count to zero", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" },
    () => ({ code: 200, body: '{"partialSuccess":{"errorMessage":"diagnostic omitted count"}}' }));
  assert.equal(f.capture(GENERATION), true);
  const invalid = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" },
    () => ({ code: 200, body: '{"partialSuccess":{"rejectedSpans":null}}' }));
  assert.equal(invalid.capture(GENERATION), false);
  assert.equal(invalid.capture(GENERATION), false);
  assert.equal(invalid.calls.length, 1);
});

 test("terminal authentication rejection never replays an accepted mirror peer", () => {
  const f = fixture(TARGET, (url) => url.includes("logfire")
    ? { code: 401, body: "" } : { code: 200, body: "{}", bytes: [] });
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.filter((call) => call.url.includes("honeycomb")).length, 1);
  const receipt = [...f.properties.entries()].find(([key]) => key.startsWith("AGENT_TELEMETRY_TRACE_"))[1];
  assert.match(receipt, /failed/);
 });

 test("429 alone receives at most three attempts with backoff, preserving accepted peer", () => {
  const delays = [];
  const f = fixture(TARGET, (url) => url.includes("logfire") ?
    { code: 429, body: "" } : { code: 200, body: "{}", bytes: [] });
  f.gas.Utilities.sleep = (ms) => delays.push(ms);
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(delays, [250, 500]);
  const logfire = JSON.parse([...f.properties.entries()].find(([key]) =>
    key.startsWith("AGENT_TELEMETRY_COUNTS_LOGFIRE_"))[1]);
  assert.equal(logfire.attempted, 3);
  assert.equal(logfire.failed, 3);
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 4);
 });

 test("protobuf partial-success responses consume reservation without replaying a partly accepted batch", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "0" },
    () => ({ code: 200, bytes: [10, 2, 8, 1] }));
  const generation = { ...GENERATION, operations: [
    { id: "real-child", name: "lookup", startedMs: 1730000000001, endedMs: 1730000000002 }] };
  assert.equal(f.capture(generation), false);
  assert.equal(f.capture(generation), false);
  assert.equal(f.calls.length, 1);
 });

 test("partial acceptance retains unresolved evidence and never replays accepted subset", () => {
  const response = { code: 200, body: '{"partialSuccess":{"rejectedSpans":1}}' };
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0",
    HONEYCOMB_ALLOWANCE: "3" }, () => response);
  const generation = { ...GENERATION, operations: [
    { id: "real-child", name: "lookup", startedMs: 1730000000001, endedMs: 1730000000002 }] };
  assert.equal(f.capture(generation), false);
  assert.equal(f.capture(generation), false);
  assert.equal(f.calls.length, 1);
  const receipt = JSON.parse([...f.properties.entries()].find(([key]) => key.startsWith("AGENT_TELEMETRY_TRACE_"))[1]);
  assert.ok(receipt.mapped?.spans?.length === 2);
  assert.equal(receipt.signals.honeycomb.spans, "partial");
 });

 test("a real child operation reserves the full span-and-log trace and preserves parentage", () => {
  const operations = [{ id: "tool-1", name: "lookup", startedMs: 1730000000001, endedMs: 1730000000002 },
    { id: "tool-2", name: "fetch" }];
  const oneUnit = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "1", LOGFIRE_ALLOWANCE: "1" });
  assert.equal(oneUnit.capture({ ...GENERATION, operations }), false);
  assert.equal(oneUnit.calls.length, 0);
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "3", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture({ ...GENERATION, operations }), true);
  const spans = JSON.parse(f.calls[0].args.payload).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.equal(spans[1].parentSpanId, spans[0].spanId);
  assert.notEqual(spans[1].spanId, spans[0].spanId);
  assert.equal(JSON.parse(f.calls[1].args.payload).resourceLogs[0].scopeLogs[0].logRecords.length, 1);
  assert.equal(f.calls.length, 2);
 });

 test("manual drain never retries an in-flight or accepted signal", () => {
  let reentered = false;
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "2", LOGFIRE_ALLOWANCE: "0" },
    (_url, _args, ordinal) => {
      if (ordinal === 1 && !reentered) {
        reentered = true;
        assert.equal(createAppsScriptObservability(f.gas).drain(), 1);
      }
      return { code: 200, body: "{}" };
    });
  assert.equal(f.capture({ ...GENERATION, operations: [{ id: "tool-1", name: "lookup" }] }), true);
  assert.equal(f.calls.length, 2);
  assert.equal(createAppsScriptObservability(f.gas).drain(), 0);
 });

 test("external usage baseline cannot decrease within a free period", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "3",
    HONEYCOMB_OTHER_USAGE: "1", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture(GENERATION), true);
  f.properties.set("HONEYCOMB_OTHER_USAGE", "0");
  assert.throws(() => f.capture({ ...GENERATION, traceId: "new" }), /decreasing external usage/);
 });

 test("rising external usage stops remaining reserved signals before an overage", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", HONEYCOMB_ALLOWANCE: "2",
    LOGFIRE_ALLOWANCE: "0" }, () => {
    f.properties.set("HONEYCOMB_OTHER_USAGE", "1");
    return { code: 200, body: "{}" };
  });
  const generation = { ...GENERATION, operations: [{ id: "real-child", name: "lookup" }] };
  assert.equal(f.capture(generation), false);
  assert.equal(f.calls.length, 1);
  assert.equal(createAppsScriptObservability(f.gas).drain(), 1);
  assert.equal(f.calls.length, 1);
 });


test("read-only usage exposes independent billing and unresolved evidence without secrets", () => {
  const f = fixture({ ...TARGET, HONEYCOMB_ALLOWANCE: "0", LOGFIRE_ALLOWANCE: "0" });
  const api = createAppsScriptObservability(f.gas);
  assert.equal(api.capture(GENERATION), false);
  assert.equal(api.capture(GENERATION), false);
  const usage = api.getUsage();
  assert.equal(usage.pending.capacity_blocked, 1);
  assert.equal(usage.destinations.length, 2);
  assert.equal(usage.destinations[0].periods[0].counts.observed, 1);
  assert.equal(usage.destinations[0].periods[0].counts.blocked, 1);
  assert.equal(usage.destinations[1].periods[0].counts.blocked, 1);
  assert.notEqual(usage.destinations[0].periods[0].period.start,
    usage.destinations[1].periods[0].period.start);
  assert.doesNotMatch(JSON.stringify(usage), /secret-h|secret-l|SECRET_PROMPT|SECRET_RESPONSE/);
});

test("billing period expiry between signals blocks the next network request", () => {
  let f;
  f = fixture(TARGET, () => {
    f.setNow(Date.UTC(2024, 10, 18));
    return { code: 200, body: "{}" };
  });
  assert.equal(f.capture(GENERATION), false);
  assert.equal(f.calls.length, 1);
  assert.equal(createAppsScriptObservability(f.gas).getUsage().pending.reserved, 1);
});

test("failed authentication retains unresolved evidence for operator without retries", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split", LOGFIRE_ALLOWANCE: "0" },
    () => ({ code: 401, body: '{"message":"secret server body"}' }));
  assert.equal(f.capture(GENERATION), false);
  assert.equal(createAppsScriptObservability(f.gas).drain(), 0);
  assert.equal(f.calls.length, 1);
  const receipt = JSON.parse([...f.properties.entries()].find(([key]) =>
    key.startsWith("AGENT_TELEMETRY_TRACE_"))[1]);
  assert.equal(receipt.signals.honeycomb.spans, "failed");
  assert.equal(receipt.mapped.spans.length, 1);
  assert.equal(createAppsScriptObservability(f.gas).getUsage().pending.failed, 1);
  assert.doesNotMatch(JSON.stringify([...f.properties.entries()]), /secret server body/);
});

test("replay repairs a persisted admission missing its observed accounting", () => {
  const f = fixture({ ...TARGET, AGENT_TELEMETRY_MODE: "split",
    HONEYCOMB_ALLOWANCE: "0", LOGFIRE_ALLOWANCE: "0" });
  assert.equal(f.capture(GENERATION), false);
  const receiptKey = [...f.properties.keys()].find((key) => key.startsWith("AGENT_TELEMETRY_TRACE_"));
  const receipt = JSON.parse(f.properties.get(receiptKey));
  delete receipt.accounting.observed.honeycomb;
  f.properties.set(receiptKey, JSON.stringify(receipt));
  const counterKey = [...f.properties.keys()].find((key) =>
    key.startsWith("AGENT_TELEMETRY_COUNTS_HONEYCOMB_"));
  const counts = JSON.parse(f.properties.get(counterKey));
  counts.observed = 0;
  f.properties.set(counterKey, JSON.stringify(counts));
  assert.equal(f.capture(GENERATION), false);
  const usage = createAppsScriptObservability(f.gas).getUsage();
  assert.equal(usage.destinations[0].periods[0].counts.observed, 1);
  assert.equal(usage.destinations[0].periods[0].counts.blocked, 1);
  assert.equal(f.calls.length, 0);
});
