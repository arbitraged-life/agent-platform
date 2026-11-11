import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { createUuidV7, turnEvent } from "../../runtime/observability/records.mjs";
import { evidenceRecord, validateEvidence, validateObservabilityRecord } from "../../runtime/observability/evidence.mjs";
import { createOtlpExporter, mapOtlpRecord, otelSpanId, otelTraceId } from "../../runtime/observability/otlp.mjs";

const startedMs = 1700000000000;
const traceId = createUuidV7(startedMs);
const base = { traceId, runtime: "omp", runId: "run", observedMs: startedMs, recordedMs: startedMs };
const start = () => evidenceRecord({ ...base, eventName: "agent.turn.started", outcome: "started" });
const finish = () => evidenceRecord({ ...base, eventName: "agent.turn.finished", endedMs: startedMs + 1000, outcome: "failed", failureStage: "provider_execution" });
const operation = (props = {}) => evidenceRecord({ ...base, eventName: "agent.operation.observed", toolName: "mcp.query", serverName: "api", outcome: "succeeded", startedMs: startedMs + 100, endedMs: startedMs + 200, ...props });
const bundle = (records) => ({ schema_version: 1, record_type: "agent.trace", event_id: traceId, trace_id: traceId, records });

function varint(value) {
  let n = BigInt(value), bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return bytes;
}
function partialResponse(rejected) {
  // ExportResponse.partial_success (1), PartialSuccess.rejected_spans/log_records (1).
  const nested = [8, ...varint(rejected)];
  return Uint8Array.from([10, nested.length, ...nested]);
}
const configurations = {
  honeycomb: { schema_version: 1, destination: "honeycomb", endpoint: "https://api.honeycomb.io", credential_env: "TOKEN", service_name: "agents" },
  logfire: { schema_version: 1, destination: "logfire", endpoint: "https://logfire-us.pydantic.dev", credential_env: "TOKEN", service_name: "agents" },
};

test("HTTP redirects are rejected explicitly without forwarding telemetry credentials", async (t) => {
  let initial = 0, redirected = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === "/ingest") {
      initial++;
      response.writeHead(307, { location: "/redirected" }).end();
    } else {
      redirected++;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  for (const destination of ["honeycomb", "logfire"]) {
    const exporter = createOtlpExporter(configurations[destination], {
      environment: { TOKEN: "synthetic-credential" },
      fetcher: (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/ingest`, options),
    });
    await assert.rejects(() => exporter(bundle([finish()])), (error) =>
      error.receipt.reason_code === "HTTP_307" &&
      error.receipt.delivery_status === "failed" && error.receipt.retryable === false);
  }
  assert.equal(initial, 2);
  assert.equal(redirected, 0);
});

test("stable OTLP IDs and exactly one completed root with child tool; no invented model span", () => {
  const records = [start(), operation(), finish()];
  const mapped = mapOtlpRecord(bundle(records));
  const mappedAgain = mapOtlpRecord(bundle(records));
  assert.deepEqual(mapped, mappedAgain);
  assert.match(otelTraceId(traceId), /^[0-9a-f]{32}$/);
  assert.match(otelSpanId(traceId), /^[0-9a-f]{16}$/);
  assert.equal(mapped.spans.length, 2);
  assert.equal(mapped.logs.length, 0);
  assert.equal(mapped.spans[0].spanId, otelSpanId(traceId));
  assert.equal(mapped.spans[1].parentSpanId, mapped.spans[0].spanId);
  assert.equal(mapped.spans[0].status.code, 2);
  assert.equal(mapped.units.honeycomb, 2);
  assert.equal(mapped.units.logfire, 2);
});

test("OTLP roots and tool signals retain captured provenance and verification boundaries", () => {
  const tool = operation({
    evidenceOrigin: "reported_observation", verificationStatus: "uncertain", productionEligible: false,
    reasonAvailability: "withheld", reasonProvenance: "summary_only", handlingOutcome: "unresolved",
  });
  const terminal = finish();
  terminal.evidence_origin = "historical_summary";
  terminal.verification_status = "not_verified";
  terminal.production_eligible = false;
  terminal.reason_availability = "withheld";
  terminal.reason_provenance = "summary_only";
  terminal.handling_outcome = "unresolved";
  const mapped = mapOtlpRecord(bundle([tool, terminal]));
  const fields = {
    "agent.evidence.origin": "reported_observation",
    "agent.verification.status": "uncertain",
    "agent.production.eligible": false,
    "agent.reason.availability": "withheld",
    "agent.reason.provenance": "summary_only",
    "agent.handling.outcome": "unresolved",
  };
  const attrs = Object.fromEntries(mapped.spans[1].attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
  for (const [key, expected] of Object.entries(fields)) assert.equal(attrs[key], expected, key);
  const root = Object.fromEntries(mapped.spans[0].attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
  assert.equal(root["agent.evidence.origin"], "historical_summary");
  assert.equal(root["agent.verification.status"], "not_verified");
  assert.equal(root["agent.production.eligible"], false);
  assert.equal(root["agent.reason.availability"], "withheld");
  assert.equal(root["agent.reason.provenance"], "summary_only");
  assert.equal(root["agent.handling.outcome"], "unresolved");
  const log = mapOtlpRecord(operation({
    startedMs: null, endedMs: null, evidenceOrigin: "reported_observation",
    verificationStatus: "uncertain", productionEligible: false,
    reasonAvailability: "withheld", reasonProvenance: "summary_only", handlingOutcome: "unresolved",
  })).logs[0];
  const logAttrs = Object.fromEntries(log.attributes.map(({ key, value }) => [key, Object.values(value)[0]]));
  assert.equal(logAttrs["agent.evidence.origin"], "reported_observation");
  assert.equal(logAttrs["agent.verification.status"], "uncertain");
  assert.equal(logAttrs["agent.production.eligible"], false);
  assert.equal(logAttrs["agent.reason.availability"], "withheld");
  assert.equal(logAttrs["agent.reason.provenance"], "summary_only");
  assert.equal(logAttrs["agent.handling.outcome"], "unresolved");
});

test("operation sharing the trace UUID remains a distinct child span", () => {
  const mapped = mapOtlpRecord(bundle([start(), operation({ eventId: traceId }), finish()]));
  const [root, child] = mapped.spans;
  assert.notEqual(child.spanId, root.spanId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.notEqual(child.parentSpanId, child.spanId);
});

test("unknown tool timing maps to a linked log rather than an invented zero-duration span", () => {
  const tool = operation({ startedMs: null, endedMs: null, toolArguments: undefined });
  assert.equal(tool.started_at, null);
  const mapped = mapOtlpRecord(bundle([tool, finish()]));
  assert.equal(mapped.spans.length, 1);
  assert.equal(mapped.logs.length, 1);
  assert.equal(mapped.logs[0].spanId, mapped.spans[0].spanId);
  assert.equal(mapped.logs[0].attributes.find((attr) => attr.key === "agent.timing.known").value.boolValue, false);
});

test("MCP activity promotes the single observed proxy tool to root without a duplicate turn", () => {
  const activity = operation({ runtime: "mcpproxy", toolName: "list_tools", serverName: "server" });
  const terminal = finish();
  terminal.runtime = "mcpproxy";
  const mapped = mapOtlpRecord(bundle([activity, terminal]));
  assert.equal(mapped.spans.length, 1);
  assert.equal(mapped.spans[0].name, "mcp.proxy.request");
  assert.equal(mapped.spans[0].parentSpanId, undefined);
  assert.equal(mapped.spans[0].attributes.find((attr) => attr.key === "agent.observation.layer").value.stringValue, "mcp_proxy");
  const unknown = mapOtlpRecord(bundle([operation({
    runtime: "mcpproxy", startedMs: null, endedMs: null,
  }), { ...terminal, started_at: null }]));
  assert.equal(unknown.spans.length, 0);
  assert.equal(unknown.logs.length, 1);
  assert.equal(unknown.logs[0].spanId, undefined);
});


test("standalone late tool retains its supplied root span link without duplicating the root", () => {
  const tool = operation({ outcome: "failed", failureStage: "provider_execution", parentEventId: traceId });
  const mapped = mapOtlpRecord(tool);
  assert.equal(mapped.spans.length, 1);
  assert.equal(mapped.spans[0].parentSpanId, mapOtlpRecord(bundle([finish()])).spans[0].spanId);
  assert.equal(mapped.spans[0].traceId, otelTraceId(traceId));
  assert.equal(mapped.spans[0].attributes.find((attr) => attr.key === "agent.parent.event_id").value.stringValue, traceId);
  assert.equal(mapped.spans[0].status.code, 2);
  const lateLog = mapOtlpRecord(operation({
    startedMs: null, endedMs: null, parentEventId: traceId,
  }));
  assert.equal(lateLog.spans.length, 0);
  assert.equal(lateLog.logs[0].spanId, mapped.spans[0].parentSpanId);
});

test("children of unknown-timing operations attach to the nearest emitted ancestor", () => {
  const parent = operation({ startedMs: null, endedMs: null });
  const child = operation({ parentEventId: parent.event_id, toolName: "child" });
  const mapped = mapOtlpRecord(bundle([parent, child, finish()]));
  assert.equal(mapped.spans.length, 2);
  assert.equal(mapped.spans[1].parentSpanId, mapped.spans[0].spanId);
  assert.equal(mapped.logs[0].spanId, mapped.spans[0].spanId);
  assert.equal(mapped.spans[1].attributes.find((attr) => attr.key === "agent.parent.event_id").value.stringValue, parent.event_id);
});
test("cyclic tool parent references fail instead of generating cyclic OTLP spans", () => {
  const first = operation();
  const second = operation({ parentEventId: first.event_id });
  first.parent_event_id = second.event_id;
  assert.throws(() => mapOtlpRecord(bundle([first, second, finish()])), /cycle|parent/i);
});
test("inconsistent cross-record start and finish timing is rejected", () => {
  const started = start();
  started.started_at = new Date(startedMs + 2000).toISOString();
  assert.throws(() => mapOtlpRecord(bundle([started, finish()])), /timing|duration/i);
});





test("terminal lacking a real start is a linked log instead of a fabricated root duration", () => {
  const terminal = finish();
  terminal.started_at = null;
  validateEvidence(terminal);
  const mapped = mapOtlpRecord(bundle([terminal]));
  assert.equal(mapped.spans.length, 0);
  assert.equal(mapped.logs.length, 1);
  assert.equal(mapped.logs[0].spanId, undefined);
  assert.equal(mapped.logs[0].attributes.find((attr) => attr.key === "agent.timing.known").value.boolValue, false);
});
test("terminal lacking a real end emits a trace log, not a fabricated duration", () => {
  const terminal = { ...finish(), ended_at: null };
  const mapped = mapOtlpRecord(bundle([start(), terminal]));
  assert.equal(mapped.spans.length, 0);
  assert.equal(mapped.logs.length, 1);
  assert.equal(mapped.logs[0].spanId, undefined);
  assert.equal(mapped.logs[0].timeUnixNano, String(BigInt(startedMs) * 1000000n));
});


test("completed summary emits only one root with aggregate model usage attributes", () => {
  const event = turnEvent({ runtime: "omp", runId: "run", startedMs, endedMs: startedMs + 1000, provider: "model-provider", modelId: "model", usage: { input: 5 } });
  const mapped = mapOtlpRecord(event);
  assert.equal(mapped.spans.length, 1);
  assert.equal(mapped.logs.length, 0);
  assert.equal(mapped.spans[0].attributes.find((attr) => attr.key === "gen_ai.usage.input_tokens").value.intValue, "5");
});

test("canonical capture is bounded and redacted; handcrafted unsanitized evidence and oversized bundles fail", () => {
  const tool = operation({ captureContent: true, toolArguments: { api_key: "my-secret", prompt: "Bearer abcdefghijklmnopqrstuvwxyz", plain: "x".repeat(9000) } });
  assert.equal(tool.tool_arguments.truncated, true);
  assert.equal(tool.tool_arguments.redacted, true);
  assert.ok(tool.tool_arguments.byte_count > 4096);
  assert.ok(!JSON.stringify(tool).includes("my-secret"));
  assert.ok(!JSON.stringify(tool).includes("abcdefghijklmnopqrstuvwxyz"));
  assert.throws(() => validateEvidence({ ...tool, tool_arguments: { ...tool.tool_arguments, preview: 'Authorization: Bearer token' } }), /capture|saniti|sensitive/i);
  assert.deepEqual(operation({ toolResult: "hidden" }).tool_result, { preview: null, byte_count: null, sha256: null, truncated: false, omitted: true, redacted: false });
  const oversized = bundle([finish(), ...Array.from({ length: 130 }, () =>
    operation({ captureContent: true, toolResult: "x".repeat(4000) }))]);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < 1024 * 1024);
  assert.throws(() => validateObservabilityRecord(oversized), /Trace bundle exceeds size limit/);
});

test("credential URIs and embedded error bodies are sanitized without losing operation evidence", () => {
  const credentialUri = new URL("postgres://example.test/db");
  credentialUri.username = "reader";
  credentialUri.password = "fake-password";
  for (const prefix of ["", "+", "a".repeat(256)]) {
    const uri = operation({ captureContent: true, toolResult: { detail: prefix + credentialUri.href } });
    assert.equal(uri.tool_result.redacted, true);
    assert.doesNotMatch(uri.tool_result.preview, /reader|fake-password/);
  }
  const error = operation({ captureContent: true, toolResult: "compile error: PRIVATE_DETAIL" });
  assert.equal(error.tool_result.redacted, true);
  assert.doesNotMatch(error.tool_result.preview, /PRIVATE_DETAIL/);
  assert.equal(error.event_name, "agent.operation.observed");
});

test("oversized source content is omitted rather than materialized and hashed in full", () => {
  for (const value of ["x".repeat(1024 * 1024), Array(4096).fill("x")]) {
    const tool = operation({ captureContent: true, toolResult: value });
    assert.equal(tool.event_name, "agent.operation.observed");
    assert.equal(tool.tool_result.omitted, true);
    assert.equal(tool.tool_result.byte_count, null);
    assert.equal(tool.tool_result.sha256, null);
  }
});

test("complete and unterminated PEM private keys never survive capture preview or digest input", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const lines = pem.trimEnd().split("\n");
  const keyBody = lines.slice(1, -1).join("\n");
  for (const value of [pem + "visible", lines.slice(0, -1).join("\n")]) {
    const tool = operation({ captureContent: true, toolResult: `prefix ${value}` });
    assert.equal(tool.tool_result.redacted, true);
    assert.ok(!JSON.stringify(tool).includes(keyBody));
    assert.ok(!tool.tool_result.preview.includes("BEGIN PRIVATE KEY"));
    assert.ok(!tool.tool_result.preview.includes("END PRIVATE KEY"));
    assert.equal(tool.tool_result.sha256,
      createHash("sha256").update(tool.tool_result.preview).digest("hex"));
  }
});


test("cyclic capture and raw exception content preserve operation evidence without exposing bodies", () => {
  const circular = {};
  circular.self = circular;
  const tool = operation({ captureContent: true, toolArguments: circular, toolResult: new Error("raw private failure") });
  assert.equal(tool.tool_arguments.omitted, true);
  assert.ok(!JSON.stringify(tool).includes("raw private failure"));
  assert.ok(tool.tool_result.preview.includes("ERROR_REDACTED"));
});

test("failed operations omit raw result bodies even when content capture is enabled", () => {
  const tool = operation({ outcome: "failed", captureContent: true, toolResult: "private provider stack trace" });
  assert.equal(tool.tool_result.omitted, true);
  assert.ok(!JSON.stringify(tool).includes("private provider stack trace"));
  const unsafe = { ...tool, tool_result: operation({
    captureContent: true, toolResult: "private provider stack trace",
  }).tool_result };
  assert.throws(() => validateEvidence(unsafe), /capture|result/i);
});

test("credential-shaped identifiers are rejected at construction and handcrafted validation boundary", () => {
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(() => operation({ toolName: credential }), /sensitive|identifier/i);
  const record = operation();
  assert.throws(() => validateEvidence({ ...record, tool_name: credential }), /sensitive|identifier/i);
  const summary = turnEvent({
    runtime: "omp", runId: "run", startedMs, endedMs: startedMs + 1,
  });
  assert.throws(() => validateObservabilityRecord({ ...summary, provider: credential }), /sensitive|identifier/i);
});




test("rejects incomplete bundles, duplicate terminal records and mismatched trace identity", () => {
  assert.throws(() => validateObservabilityRecord(bundle([start()])), /terminal|complete/i);
  assert.throws(() => validateObservabilityRecord(bundle([finish(), finish()])), /terminal|complete/i);
  assert.throws(() => validateObservabilityRecord(bundle([operation({ traceId: createUuidV7(startedMs + 1) }), finish()])), /trace/i);
});

test("Honeycomb fully accepts a completed root with standard OTLP JSON", async () => {
  const seen = [];
  const exporter = createOtlpExporter(configurations.honeycomb, {
    environment: { TOKEN: "secret" },
    fetcher: async (url, options) => {
      seen.push({ url, options });
      return new Response("{}");
    },
  });
  const receipt = await exporter(bundle([start(), finish()]));
  assert.equal(receipt.delivery_status, "accepted");
  assert.equal(receipt.billable_counts.accepted_spans, 1);
  assert.equal(receipt.units.honeycomb, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.headers["x-honeycomb-team"], "secret");
  assert.equal(JSON.parse(seen[0].options.body).resourceSpans[0].scopeSpans[0].spans.length, 1);
});

test("Honeycomb JSON response partial success counts rejection and does not replay an accepted signal", async () => {
  const sent = [];
  const exporter = createOtlpExporter(configurations.honeycomb, { environment: { TOKEN: "secret" }, fetcher: async (url, options) => {
    sent.push({ url, options });
    return new Response(JSON.stringify(sent.length === 1 ? { partialSuccess: { rejectedSpans: 1, errorMessage: "untrusted content" } } : {}), { headers: { "content-type": "application/json" } });
  } });
  const record = bundle([operation(), finish()]);
  let failure;
  try { await exporter(record); } catch (error) { failure = error; }
  assert.equal(failure.receipt.retryable, false);
  assert.equal(failure.receipt.billable_counts.rejected_spans, 1);
  assert.equal(failure.receipt.billable_counts.accepted_spans, 1);
  assert.equal(failure.receipt.accepted_records.length, 1);
  assert.ok(!JSON.stringify(failure).includes("untrusted content"));
  await assert.rejects(() => exporter(record, {
    acceptedRecords: failure.receipt.accepted_records, previousReceipt: failure.receipt,
  }), (error) => error.receipt.has_partial_rejection === true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.headers["Content-Type"], "application/json");
});
test("partial trace rejection still exports related unknown-timing logs and counts both signals", async () => {
  const sent = [];
  const exporter = createOtlpExporter(configurations.honeycomb, {
    environment: { TOKEN: "secret" },
    fetcher: async (url) => {
      sent.push(url);
      return new Response(JSON.stringify(url.endsWith("/traces") ?
        { partialSuccess: { rejectedSpans: 1 } } : {}));
    },
  });
  let failure;
  try { await exporter(bundle([operation({ startedMs: null, endedMs: null }), finish()])); }
  catch (error) { failure = error; }
  assert.equal(failure.receipt.billable_counts.rejected_spans, 1);
  assert.equal(failure.receipt.billable_counts.accepted_logs, 1);
  assert.equal(failure.receipt.accepted_records.length, 2);
  assert.equal(sent.length, 2);
});

test("partial span rejection survives later log 429 and successful log retry", async () => {
  const sent = [];
  const checkpoints = [];
  const record = bundle([operation(), operation({ startedMs: null, endedMs: null }), finish()]);
  const exporter = createOtlpExporter(configurations.honeycomb, {
    environment: { TOKEN: "secret" },
    fetcher: async (url) => {
      sent.push(url);
      if (sent.length === 1) return new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 1 } }));
      if (sent.length === 2) return new Response(null, { status: 429 });
      return new Response("{}");
    },
  });
  let failure;
  try { await exporter(record, { onSignal: async (checkpoint) => checkpoints.push(checkpoint) }); }
  catch (error) { failure = error; }
  assert.equal(failure.receipt.retryable, true);
  assert.equal(failure.receipt.has_partial_rejection, true);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].billable_counts.attempted_spans, 2);
  assert.equal(checkpoints[0].billable_counts.accepted_spans, 1);
  assert.equal(checkpoints[1].billable_counts.attempted_logs, 1);
  assert.equal(checkpoints[1].receipt.signal_outcomes.spans.rejected, 1);
  await assert.rejects(() => exporter(record, {
    acceptedRecords: failure.receipt.accepted_records, previousReceipt: failure.receipt,
    onSignal: async (checkpoint) => checkpoints.push(checkpoint),
  }), (error) => error.receipt.delivery_status === "failed" &&
    error.receipt.retryable === false && error.receipt.has_partial_rejection === true);
  assert.equal(sent.length, 3);
  assert.ok(sent[2].endsWith("/logs"));
  assert.equal(checkpoints[2].billable_counts.attempted_spans, 0);
  assert.equal(checkpoints[2].billable_counts.attempted_logs, 1);
});

test("partial-success JSON warning with omitted zero rejection count is full acceptance", async () => {
  const exporter = createOtlpExporter(configurations.honeycomb, {
    environment: { TOKEN: "secret" },
    fetcher: async () => new Response(JSON.stringify({ partialSuccess: { errorMessage: "warning only" } })),
  });
  const receipt = await exporter(bundle([finish()]));
  assert.equal(receipt.delivery_status, "accepted");
  assert.equal(receipt.billable_counts.rejected_spans, 0);
});

test("empty partial-success messages acknowledge spans and logs with protobuf defaults", async () => {
  const exporter = createOtlpExporter(configurations.honeycomb, {
    environment: { TOKEN: "synthetic" },
    fetcher: async () => new Response(JSON.stringify({ partialSuccess: {} })),
  });
  const receipt = await exporter(bundle([finish(), operation({ startedMs: null, endedMs: null })]));
  assert.equal(receipt.delivery_status, "accepted");
  assert.equal(receipt.billable_counts.accepted_spans, 1);
  assert.equal(receipt.billable_counts.accepted_logs, 1);
  assert.equal(receipt.billable_counts.rejected_spans + receipt.billable_counts.rejected_logs, 0);
});

test("429 before traces cannot count unattempted logs", async () => {
  const checkpoints = [];
  const exporter = createOtlpExporter(configurations.honeycomb, {
    environment: { TOKEN: "secret" }, fetcher: async () => new Response(null, { status: 429 }),
  });
  await assert.rejects(() => exporter(bundle([
    operation({ startedMs: null, endedMs: null }), finish(),
  ]), { onSignal: async (checkpoint) => checkpoints.push(checkpoint) }));
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].billable_counts.attempted_spans, 1);
  assert.equal(checkpoints[0].billable_counts.attempted_logs, 0);
});



test("Logfire uses protobuf and parses partial log rejection; retries only known 429 nonacceptance", async () => {
  const record = bundle([operation({ startedMs: null, endedMs: null }), finish()]);
  const sent = [];
  const exporter = createOtlpExporter(configurations.logfire, { environment: { TOKEN: "secret" }, fetcher: async (url, options) => {
    sent.push({ url, options });
    if (sent.length === 1) return new Response(null, { status: 429 });
    return new Response(partialResponse(url.endsWith("/logs") ? 1 : 0), { headers: { "content-type": "application/x-protobuf" } });
  } });
  let failure;
  try { await exporter(record); } catch (error) { failure = error; }
  assert.equal(failure.receipt.retryable, true);
  try { await exporter(record); } catch (error) { failure = error; }
  assert.equal(failure.receipt.retryable, false);
  assert.equal(failure.receipt.billable_counts.rejected_logs, 1);
  assert.equal(failure.receipt.accepted_records.length, 2);
  assert.equal(sent[1].options.headers["Content-Type"], "application/x-protobuf");
  assert.ok(sent[1].options.body instanceof Uint8Array);
  await assert.rejects(() => exporter(record, {
    acceptedRecords: failure.receipt.accepted_records, previousReceipt: failure.receipt,
  }), (error) => error.receipt.has_partial_rejection === true);
  assert.equal(sent.length, 3);
  assert.ok(sent[2].url.endsWith("/logs"));
});

test("transport and malformed successful responses remain uncertain, never expose response bodies", async () => {
  for (const destination of ["honeycomb", "logfire"]) {
    const exporter = createOtlpExporter(configurations[destination], { environment: { TOKEN: "secret" }, fetcher: async () => new Response("untrusted raw body") });
    await assert.rejects(() => exporter(bundle([finish()])), (error) => error.receipt.delivery_status === "uncertain" && error.receipt.retryable === false && !JSON.stringify(error).includes("untrusted raw body"));
  }
  assert.throws(() => createOtlpExporter({ ...configurations.logfire, endpoint: "https://evil.example" }, { environment: { TOKEN: "secret" } }), /endpoint/i);
});
