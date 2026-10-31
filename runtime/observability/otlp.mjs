import { createHash } from "node:crypto";
import { sanitizeTelemetryString, validateObservabilityRecord } from "./evidence.mjs";
import { DeliveryError, acceptedReceipt, sendTelemetry } from "./delivery.mjs";
import configSchema from "../../schemas/otlp-config.schema.json" with { type: "json" };

const HOSTS = {
  honeycomb: new Set(["api.honeycomb.io", "api.eu1.honeycomb.io"]),
  logfire: new Set(["logfire-us.pydantic.dev", "logfire-eu.pydantic.dev"]),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 64 * 1024;

export function otelTraceId(sourceId) {
  if (!UUID.test(sourceId)) throw new Error("Invalid OTLP trace ID");
  return sourceId.replaceAll("-", "").toLowerCase();
}
export function otelSpanId(sourceId, label = "") {
  if (!UUID.test(sourceId)) throw new Error("Invalid OTLP span ID");
  return createHash("sha256").update(`agent-platform:otlp:span:${sourceId.toLowerCase()}:${label}`).digest("hex").slice(0, 16);
}
function safe(value) { return sanitizeTelemetryString(String(value)).slice(0, 4096); }
function attributes(values) {
  return Object.entries(values).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => ({
    key,
    value: typeof value === "boolean" ? { boolValue: value } :
      typeof value === "number" && Number.isSafeInteger(value) ? { intValue: String(value) } :
      typeof value === "number" && Number.isFinite(value) ? { doubleValue: value } : { stringValue: safe(value) },
  }));
}
function timestamp(iso) { return iso === null ? undefined : String(BigInt(Date.parse(iso)) * 1000000n); }
function rootSpan(traceId, terminal, start) {
  const summary = terminal.event_name === "agent.turn.completed" ? terminal : terminal.metrics;
  const status = terminal.status ?? terminal.outcome;
  const rootName = terminal.runtime === "mcpproxy" ? "mcp.proxy.request" :
    terminal.runtime === "ai-gateway" ? "gateway.decision" : "agent.turn";
  const startTime = summary?.started_at ?? start?.started_at ?? terminal.started_at;
  const endTime = summary?.ended_at ?? terminal.ended_at;
  if (!terminal.observed_at && !endTime) throw new Error("Missing terminal observation");
  if (startTime !== null && endTime !== null && endTime < startTime)
    throw new Error("Inconsistent terminal timing");
  const attrs = {
    "gen_ai.operation.name": terminal.runtime === "mcpproxy" ? "execute_tool" :
      terminal.runtime === "ai-gateway" ? "gateway.decision" : "invoke_agent",
    "gen_ai.agent.name": terminal.agent_id ?? terminal.runtime,
    "gen_ai.conversation.id": terminal.conversation_id ?? null,
    "agent.run.id": terminal.run_id, "agent.task.id": terminal.task_id ?? null,
    "agent.outcome": status, "agent.timing.known": startTime !== null && endTime !== null,
    "agent.attempt": terminal.attempt ?? null,
    "agent.action.key": terminal.action_key ?? null,
    "agent.reason.code": terminal.reason_code ?? null,
    "agent.tool.call_id": terminal.tool_call_id ?? null,
    "agent.tool.calls": terminal.tool_calls ?? summary?.tool_calls ?? null,
    "agent.tool.failures": terminal.tool_failures ?? summary?.tool_failures ?? null,
    "gen_ai.provider.name": terminal.provider ?? summary?.provider ?? null,
    "gen_ai.request.model": terminal.model_id ?? summary?.model_id ?? null,
  };
  for (const [name, value] of Object.entries(summary?.usage ?? {})) {
    if (value !== null) attrs[name === "cost_usd" ? "gen_ai.usage.cost_usd" : `gen_ai.usage.${name}`] = value;
  }
  const identity = { traceId: otelTraceId(traceId), spanId: otelSpanId(traceId) };
  if (startTime === null || endTime === null) return { log: {
    traceId: identity.traceId, timeUnixNano: timestamp(endTime ?? terminal.observed_at),
    body: { stringValue: "Agent turn with incomplete timing" },
    attributes: attributes(attrs), severityNumber: ["failed", "denied", "timed_out"].includes(status) ? 17 : 9,
  } };
  return { span: {
    ...identity, name: rootName, kind: 1, startTimeUnixNano: timestamp(startTime),
    endTimeUnixNano: timestamp(endTime), attributes: attributes(attrs),
    status: { code: ["failed", "denied", "timed_out"].includes(status) ? 2 : status === "succeeded" ? 1 : 0 },
  } };
}
function operation(record, { parentSpanId = otelSpanId(record.trace_id), root = false } = {}) {
  const traceId = otelTraceId(record.trace_id);
  const base = {
    "gen_ai.operation.name": "execute_tool", "gen_ai.agent.name": record.runtime,
    "gen_ai.conversation.id": record.conversation_id ?? null,
    "agent.task.id": record.task_id ?? null, "agent.run.id": record.run_id,
    "gen_ai.tool.name": record.tool_name, "agent.tool.server": record.server_name ?? null,
    "agent.parent.event_id": record.parent_event_id ?? null,
    "agent.observation.layer": record.runtime === "mcpproxy" ? "mcp_proxy" : null,
    "agent.tool.call_id": record.tool_call_id,
    "agent.attempt.id": record.attempt_id, "agent.outcome": record.outcome,
    "agent.failure.stage": record.failure_stage,
    "agent.reason.code": record.reason_code,
    "agent.tool.arguments.preview": record.tool_arguments?.preview,
    "agent.tool.arguments.bytes": record.tool_arguments?.byte_count,
    "agent.tool.arguments.sha256": record.tool_arguments?.sha256,
    "agent.tool.arguments.truncated": record.tool_arguments?.truncated,
    "agent.tool.arguments.omitted": record.tool_arguments?.omitted,
    "agent.tool.arguments.redacted": record.tool_arguments?.redacted,
    "agent.tool.result.preview": record.tool_result?.preview,
    "agent.tool.result.bytes": record.tool_result?.byte_count,
    "agent.tool.result.sha256": record.tool_result?.sha256,
    "agent.tool.result.truncated": record.tool_result?.truncated,
    "agent.tool.result.omitted": record.tool_result?.omitted,
    "agent.tool.result.redacted": record.tool_result?.redacted,
  };
  if (record.started_at === null || record.ended_at === null) return {
    log: { traceId, ...(parentSpanId ? { spanId: parentSpanId } : {}),
      timeUnixNano: timestamp(record.observed_at),
      body: { stringValue: root ? "MCP proxy request with unknown timing" : "Agent tool operation with unknown timing" },
      attributes: attributes({ ...base, "agent.timing.known": false, "agent.event.id": record.event_id }),
      severityNumber: ["failed", "denied"].includes(record.outcome) ? 17 : 9 },
  };
  return { span: {
    traceId, spanId: otelSpanId(record.event_id), ...(parentSpanId ? { parentSpanId } : {}),
    name: root ? "mcp.proxy.request" : safe(record.tool_name ?? "agent.tool"), kind: 1,
    startTimeUnixNano: timestamp(record.started_at), endTimeUnixNano: timestamp(record.ended_at),
    attributes: attributes({ ...base, "agent.timing.known": true }),
    status: { code: ["failed", "denied"].includes(record.outcome) ? 2 : record.outcome === "succeeded" ? 1 : 0 },
  } };
}
/** A completed agent turn has one root; MCP proxy evidence is its own observed root. */
export function mapOtlpRecord(record) {
  validateObservabilityRecord(record);
  const records = record.record_type === "agent.trace" ? record.records : [record];
  const start = records.find((item) => item.event_name === "agent.turn.started");
  const terminal = records.find((item) => ["agent.turn.finished", "agent.turn.completed"].includes(item.event_name));
  const spans = [];
  const logs = [];
  const mcpActivity = record.record_type === "agent.trace" && terminal?.runtime === "mcpproxy";
  const operations = new Map(records.filter((item) => item.event_name === "agent.operation.observed").map((item) => [item.event_id, item]));
  if (mcpActivity && operations.size !== 1) throw new Error("MCP activity requires one observed operation");
  const traceId = record.trace_id ?? record.event_id;
  const emittedRoot = !mcpActivity && terminal &&
    (terminal.metrics?.started_at ?? start?.started_at ?? terminal.started_at) !== null &&
    (terminal.metrics?.ended_at ?? terminal.ended_at) !== null;
  function nearestParent(item) {
    if (mcpActivity) return null;
    // A late standalone event carries an explicit propagated parent reference.
    // Its parent was delivered previously, outside this record's mapping context.
    if (record.record_type !== "agent.trace" && item.parent_event_id)
      return otelSpanId(item.parent_event_id);
    let ancestor = item.parent_event_id;
    let nearest = null;
    const visited = new Set([item.event_id]);
    while (ancestor && ancestor !== traceId) {
      if (visited.has(ancestor)) throw new Error("Cyclic operation parent");
      visited.add(ancestor);
      const parent = operations.get(ancestor);
      if (!parent) break;
      if (nearest === null && parent.started_at !== null && parent.ended_at !== null)
        nearest = otelSpanId(parent.event_id);
      ancestor = parent.parent_event_id;
    }
    return nearest ?? (emittedRoot ? otelSpanId(traceId) : null);
  }
  if (terminal && !mcpActivity) {
    const root = rootSpan(traceId, terminal, start);
    if (root.span) spans.push(root.span);
    else logs.push(root.log);
  }
  for (const item of operations.values()) {
    const mapped = operation(item, { parentSpanId: nearestParent(item), root: mcpActivity });
    if (mapped.span) spans.push(mapped.span);
    else logs.push(mapped.log);
  }
  return { spans, logs, units: { honeycomb: spans.length + logs.length, logfire: spans.length + logs.length } };
}
export function validateOtlpConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).length !== configSchema.required.length ||
      configSchema.required.some((key) => !Object.hasOwn(config, key)) || config.schema_version !== 1 ||
      !Object.hasOwn(HOSTS, config.destination) ||
      typeof config.endpoint !== "string" || !configSchema.properties.endpoint.enum.includes(config.endpoint))
    throw new Error("Invalid OTLP endpoint configuration");
  const url = new URL(config.endpoint);
  if (!HOSTS[config.destination].has(url.hostname) || url.protocol !== "https:" ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Invalid OTLP endpoint");
  if (typeof config.credential_env !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(config.credential_env) ||
      typeof config.service_name !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(config.service_name))
    throw new Error("Invalid OTLP configuration");
  return config;
}

// Minimal protobuf wire encoding for the fixed OTLP/HTTP trace and log messages (proto3).
// Logfire documents http/protobuf; Honeycomb documents http/json. No SDK/runtime dependency.
function varint(value) {
  let n = BigInt(value);
  if (n < 0n) throw new Error("Invalid OTLP integer");
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
function wire(field, value, type = "bytes") {
  if (type === "number") return Buffer.concat([varint(field * 8), varint(value)]);
  if (type === "fixed64") { const data = Buffer.allocUnsafe(8); data.writeBigUInt64LE(BigInt(value)); return Buffer.concat([varint(field * 8 + 1), data]); }
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]);
}
function message(parts) { return Buffer.concat(parts.filter(Boolean)); }
function any(value) {
  if (Object.hasOwn(value, "stringValue")) return wire(1, value.stringValue);
  if (Object.hasOwn(value, "boolValue")) return wire(2, Number(value.boolValue), "number");
  if (Object.hasOwn(value, "intValue")) return wire(3, value.intValue, "number");
  if (Object.hasOwn(value, "doubleValue")) { const data = Buffer.allocUnsafe(8); data.writeDoubleLE(value.doubleValue); return Buffer.concat([varint(4 * 8 + 1), data]); }
  throw new Error("Invalid OTLP attribute");
}
function attrs(items) { return items.map(({ key, value }) => wire(9, message([wire(1, key), wire(2, any(value))]))); }
function protoSpan(span) {
  return message([
    wire(1, Buffer.from(span.traceId, "hex")), wire(2, Buffer.from(span.spanId, "hex")),
    span.parentSpanId && wire(4, Buffer.from(span.parentSpanId, "hex")), wire(5, span.name),
    wire(6, span.kind, "number"), span.startTimeUnixNano && wire(7, span.startTimeUnixNano, "fixed64"),
    wire(8, span.endTimeUnixNano, "fixed64"), ...attrs(span.attributes),
    wire(15, wire(3, span.status.code, "number")),
  ]);
}
function protoLog(log) {
  return message([
    wire(1, log.timeUnixNano, "fixed64"), wire(2, log.severityNumber, "number"),
    wire(5, any(log.body)), ...log.attributes.map(({ key, value }) => wire(6, message([wire(1, key), wire(2, any(value))]))),
    wire(9, Buffer.from(log.traceId, "hex")),
    log.spanId && wire(10, Buffer.from(log.spanId, "hex")),
  ]);
}
function protoRequest(signal, items, serviceName) {
  const resource = wire(1, message([wire(1, "service.name"), wire(2, any({ stringValue: serviceName }))]));
  const scope = wire(1, "agent-platform");
  const scopeRecords = message([wire(1, scope), ...items.map((item) => wire(2, signal === "spans" ? protoSpan(item) : protoLog(item)))]);
  return wire(1, message([wire(1, resource), wire(2, scopeRecords)]));
}
function jsonRequest(signal, items, serviceName) {
  const key = signal === "spans" ? "resourceSpans" : "resourceLogs";
  const scopeKey = signal === "spans" ? "scopeSpans" : "scopeLogs";
  const itemKey = signal === "spans" ? "spans" : "logRecords";
  return JSON.stringify({ [key]: [{ resource: { attributes: attributes({ "service.name": serviceName }) },
    [scopeKey]: [{ scope: { name: "agent-platform" }, [itemKey]: items }] }] });
}
async function responseBytes(response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Large OTLP response");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
function parseProtobufResponse(bytes) {
  let offset = 0, rejected = 0, seen = false;
  function number(data, at) {
    let result = 0n, shift = 0n;
    for (let i = 0; i < 10 && at < data.length; i++) {
      const byte = data[at++]; result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return [result, at];
      shift += 7n;
    }
    throw new Error("Invalid OTLP response");
  }
  while (offset < bytes.length) {
    const [tag, next] = number(bytes, offset); offset = next;
    if (tag !== 10n) throw new Error("Invalid OTLP response");
    const [length, bodyStart] = number(bytes, offset); offset = bodyStart;
    if (length > BigInt(bytes.length - offset)) throw new Error("Invalid OTLP response");
    const body = bytes.subarray(offset, offset + Number(length)); offset += Number(length);
    seen = true;
    let index = 0;
    while (index < body.length) {
      const [field, pos] = number(body, index); index = pos;
      if (field === 8n) {
        const [value, end] = number(body, index); index = end;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid rejection count");
        rejected = Number(value);
      } else if (field === 18n) {
        const [size, start] = number(body, index); index = start + Number(size);
        if (index > body.length) throw new Error("Invalid OTLP response");
      } else throw new Error("Invalid OTLP response");
    }
  }
  return { rejected, partial: seen };
}
function parseJsonResponse(bytes, signal) {
  const result = JSON.parse(bytes.toString("utf8"));
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).some((key) => key !== "partialSuccess" && key !== "partial_success"))
    throw new Error("Invalid OTLP response");
  const partial = Object.hasOwn(result, "partialSuccess") ? result.partialSuccess : result.partial_success;
  if (partial === undefined && !Object.hasOwn(result, "partial_success")) return { rejected: 0, partial: false };
  if (!partial || typeof partial !== "object" || Array.isArray(partial)) throw new Error("Invalid OTLP response");
  const count = signal === "spans" ? partial.rejectedSpans ?? partial.rejected_spans : partial.rejectedLogRecords ?? partial.rejected_log_records;
  if (count === undefined && typeof (partial.errorMessage ?? partial.error_message) === "string" &&
      (partial.errorMessage ?? partial.error_message).length > 0)
    return { rejected: 0, partial: true };
  if (!(typeof count === "number" && Number.isSafeInteger(count) && count >= 0) &&
      !(typeof count === "string" && /^(?:0|[1-9][0-9]*)$/.test(count) && Number.isSafeInteger(Number(count))))
    throw new Error("Invalid OTLP rejection count");
  return { rejected: Number(count), partial: true };
}
function counts(mapped) {
  return { spans: mapped.spans.length, logs: mapped.logs.length,
    attempted_spans: 0, attempted_logs: 0, accepted_spans: 0, accepted_logs: 0,
    rejected_spans: 0, rejected_logs: 0 };
}
function safeError(code, status, accepted, billable, signalOutcomes, hasPartial, retryable = false) {
  const error = new DeliveryError({ code, status, retryable, acceptedRecords: accepted });
  error.receipt.billable_counts = { ...billable };
  error.receipt.signal_outcomes = structuredClone(signalOutcomes);
  error.receipt.has_partial_rejection = hasPartial;
  return error;
}
export function createOtlpExporter(configuration, { environment = process.env, fetcher = fetch } = {}) {
  const config = validateOtlpConfig(configuration);
  const credential = environment[config.credential_env];
  if (typeof credential !== "string" || !credential.trim())
    throw new Error("Telemetry credential is unavailable");
  return async (record, { acceptedRecords = [], previousReceipt = null, onSignal = null } = {}) => {
    let snapshot;
    try { snapshot = structuredClone(record); }
    catch { throw new Error("Invalid telemetry event snapshot"); }
    const mapped = mapOtlpRecord(snapshot);
    const eventId = snapshot.trace_id ?? snapshot.event_id;
    const traceId = otelTraceId(eventId);
    const accepted = [...new Set([...acceptedRecords, ...(previousReceipt?.accepted_records ?? [])])];
    const signalOutcomes = structuredClone(previousReceipt?.signal_outcomes ?? {});
    let hasPartial = previousReceipt?.has_partial_rejection === true ||
      Object.values(signalOutcomes).some((entry) => entry.rejected > 0) ||
      ((previousReceipt?.billable_counts?.rejected_spans ?? 0) +
       (previousReceipt?.billable_counts?.rejected_logs ?? 0)) > 0 ||
      (acceptedRecords.length > 0 && previousReceipt === null);
    const billable = counts(mapped);
    const failure = (code, status, retryable = false) =>
      safeError(code, status, accepted, billable, signalOutcomes, hasPartial, retryable);
    for (const signal of ["spans", "logs"]) {
      const items = mapped[signal];
      if (!items.length) continue;
      const key = `${signal}:${traceId}`;
      if (accepted.includes(key)) continue;
      const isJson = config.destination === "honeycomb";
      const body = isJson ?
        jsonRequest(signal, items, config.service_name) :
        protoRequest(signal, items, config.service_name);
      if (Buffer.byteLength(body) > 1024 * 1024) throw failure("EXPORT_FAILED", "failed");
      const delta = {
        attempted_spans: signal === "spans" ? items.length : 0,
        attempted_logs: signal === "logs" ? items.length : 0,
        accepted_spans: 0, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0,
      };
      billable[`attempted_${signal}`] += items.length;
      let response;
      let error = null;
      try {
        response = await sendTelemetry(fetcher,
          `${config.endpoint}/v1/${signal === "spans" ? "traces" : "logs"}`, {
            method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": isJson ? "application/json" : "application/x-protobuf",
              ...(isJson ? { "x-honeycomb-team": credential } : { Authorization: credential }) },
            body,
          }, accepted);
      } catch (cause) {
        error = cause instanceof DeliveryError ? cause : failure("TRANSPORT_UNCERTAIN", "uncertain");
      }
      let outcome;
      if (!error) {
        try {
          const bytes = await responseBytes(response);
          outcome = isJson ? parseJsonResponse(bytes, signal) : parseProtobufResponse(bytes);
          if (outcome.rejected > items.length) throw new Error("Invalid OTLP rejection count");
        } catch {
          error = failure("TRANSPORT_UNCERTAIN", "uncertain");
        }
      }
      if (!error) {
        delta[`accepted_${signal}`] = items.length - outcome.rejected;
        delta[`rejected_${signal}`] = outcome.rejected;
        billable[`accepted_${signal}`] += delta[`accepted_${signal}`];
        billable[`rejected_${signal}`] += delta[`rejected_${signal}`];
        if (outcome.rejected > 0) hasPartial = true;
        accepted.push(key); // Partial success cannot identify the rejected resources.
      }
      const prior = signalOutcomes[signal] ?? { attempted: 0, accepted: 0, rejected: 0 };
      const status = error?.receipt.delivery_status ?? (outcome.rejected > 0 ? "failed" : "accepted");
      signalOutcomes[signal] = {
        attempted: prior.attempted + items.length,
        accepted: prior.accepted + delta[`accepted_${signal}`],
        rejected: prior.rejected + delta[`rejected_${signal}`],
        status,
      };
      const checkpoint = { ...acceptedReceipt(eventId, [...accepted]),
        status: "pending", delivery_status: "pending",
        billable_counts: { ...billable }, signal_outcomes: structuredClone(signalOutcomes),
        has_partial_rejection: hasPartial, units: mapped.units };
      if (onSignal) {
        try {
          await onSignal({ signal, status, accepted_records: [...accepted],
            billable_counts: delta, receipt: checkpoint });
        } catch {
          throw failure("TRANSPORT_UNCERTAIN", "uncertain");
        }
      }
      if (error) {
        error.receipt.billable_counts = { ...billable };
        error.receipt.signal_outcomes = structuredClone(signalOutcomes);
        error.receipt.has_partial_rejection = hasPartial;
        error.receipt.accepted_records = [...accepted];
        throw error;
      }
    }
    if (hasPartial) throw failure("EXPORT_FAILED", "failed");
    return { ...acceptedReceipt(eventId, accepted),
      billable_counts: billable, signal_outcomes: signalOutcomes,
      has_partial_rejection: false, units: mapped.units };
  };
}
