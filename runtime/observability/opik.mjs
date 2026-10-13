import { createHash } from "node:crypto";
import { validateEvent } from "./records.mjs";
import { validateEvidence } from "./evidence.mjs";
import { sendTelemetry, acceptedReceipt } from "./delivery.mjs";
import configSchema from "../../schemas/opik-config.schema.json" with { type: "json" };

export function validateOpikConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Invalid telemetry configuration");
  const keys = configSchema.required;
  if (Object.keys(config).some((key) => !keys.includes(key)) || config.schema_version !== 1)
    throw new Error("Unsupported telemetry configuration");
  if (keys.slice(1).some((key) => typeof config[key] !== "string" || !config[key].trim()))
    throw new Error("Missing telemetry configuration");
  if (!new RegExp(configSchema.properties.endpoint.pattern).test(config.endpoint))
    throw new Error("Invalid telemetry endpoint");
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error("Invalid telemetry endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    config.endpoint.includes("?") ||
    config.endpoint.includes("#")
  )
    throw new Error("Invalid telemetry endpoint");
  if (!/^[A-Z][A-Z0-9_]*$/.test(config.credential_env)) throw new Error("Invalid credential reference");
  if ([config.workspace, config.project].some((value) => value.length > 256 || /[\x00-\x1f\x7f]/.test(value)))
    throw new Error("Invalid telemetry destination");
  return { ...config, endpoint: endpoint.href.replace(/\/+$/, "") };
}

// Preserve the event timestamp; derive stable UUIDv7 random bits for its span.
function spanId(eventId) {
  const bytes = createHash("sha256")
    .update("agent-platform:agent.model:" + eventId.toLowerCase())
    .digest()
    .subarray(0, 16);
  Buffer.from(eventId.replaceAll("-", ""), "hex").copy(bytes, 0, 0, 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Both adapters use the same IDs, terminology, units and unknown-value handling. */
export function opikRecords(event, project) {
  try {
    event = structuredClone(event);
  } catch {
    throw new Error("Invalid telemetry event snapshot");
  }
  validateEvent(event);
  const trace = {
    id: event.event_id,
    name: event.event_name,
    project_name: project,
    start_time: event.started_at,
    end_time: event.ended_at,
    thread_id: event.run_id,
    metadata: event,
    tags: ["agent-platform", event.runtime],
  };
  const span = {
    id: spanId(event.event_id),
    trace_id: trace.id,
    project_name: project,
    name: "agent.model",
    type: "llm",
    start_time: event.started_at,
    end_time: event.ended_at,
    metadata: event,
  };
  if (event.provider !== null) span.provider = event.provider;
  if (event.model_id !== null) span.model = event.model_id;
  const usage = {};
  for (const [target, source] of [
    ["prompt_tokens", "input_tokens"],
    ["completion_tokens", "output_tokens"],
    ["total_tokens", "total_tokens"],
  ])
    if (event.usage[source] !== null) usage[target] = event.usage[source];
  if (Object.keys(usage).length) span.usage = usage;
  return { trace, span };
}

export function createOpikExporter(configuration, { environment = process.env, fetcher = fetch } = {}) {
  const config = validateOpikConfig(configuration),
    credential = environment[config.credential_env];
  if (typeof credential !== "string" || !credential.trim())
    throw new Error("Telemetry credential is unavailable");
  return async (event, { acceptedRecords = [] } = {}) => {
    let snapshot;
    try {
      snapshot = structuredClone(event);
    } catch {
      throw new Error("Invalid telemetry event snapshot");
    }
    const requests = [];
    if (snapshot.record_type === "agent.evidence") {
      validateEvidence(snapshot);
      const base = { project_name: config.project, metadata: snapshot };
      if (snapshot.event_name === "agent.operation.observed") {
        requests.push({
          key: `span:${snapshot.event_id}`,
          resource: "spans",
          method: "POST",
          record: {
            ...base,
            id: snapshot.event_id,
            trace_id: snapshot.trace_id,
            name: snapshot.tool_name ?? "operation",
            type: "tool",
            start_time: snapshot.started_at,
            ...(snapshot.ended_at ? { end_time: snapshot.ended_at } : {}),
            ...(["failed", "denied"].includes(snapshot.outcome)
              ? { error_info: { message: `Operation ${snapshot.outcome}; stage=${snapshot.failure_stage}` } }
              : {}),
          },
        });
      } else if (snapshot.event_name === "agent.turn.started") {
        requests.push({
          key: `start:${snapshot.trace_id}`,
          resource: "traces",
          method: "POST",
          record: {
            ...base,
            id: snapshot.trace_id,
            name: "agent.turn",
            thread_id: snapshot.run_id,
            start_time: snapshot.started_at,
            tags: ["agent-platform", snapshot.runtime],
          },
        });
      } else {
        requests.push({
          key: `finish:${snapshot.trace_id}`,
          resource: `traces/${snapshot.trace_id}`,
          method: "PATCH",
          record: { ...base, end_time: snapshot.ended_at },
        });
        if (snapshot.metrics !== null) {
          const { span } = opikRecords(snapshot.metrics, config.project);
          requests.push({ key: `model:${span.id}`, resource: "spans", method: "POST", record: span });
        }
      }
    } else {
      const records = opikRecords(snapshot, config.project);
      for (const [resource, record] of [
        ["traces", records.trace],
        ["spans", records.span],
      ])
        requests.push({ key: `${resource}:${record.id}`, resource, method: "POST", record });
    }
    const accepted = [...acceptedRecords];
    for (const { key, resource, method, record } of requests) {
      if (accepted.includes(key)) continue;
      await sendTelemetry(
        fetcher,
        `${config.endpoint}/v1/private/${resource}`,
        {
          method,
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            "Comet-Workspace": config.workspace,
            authorization: credential,
          },
          body: JSON.stringify(record),
          signal: AbortSignal.timeout(5000),
        },
        accepted,
      );
      accepted.push(key);
    }
    return acceptedReceipt(snapshot.trace_id ?? snapshot.event_id, accepted);
  };
}
