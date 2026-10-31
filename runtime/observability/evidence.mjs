import { createHash } from "node:crypto";
import { createUuidV7, validateEvent } from "./records.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-zA-Z0-9_.:-]{1,128}$/;
const KINDS = ["agent.turn.started", "agent.operation.observed", "agent.turn.finished"];
const OUTCOMES = ["started", "succeeded", "failed", "denied", "uncertain", "suppressed", "cancelled", "unknown"];
const STAGES = ["none", "input_validation", "platform_approval", "connector_authentication", "provider_execution", "readback", "telemetry_export", "shutdown", "unknown"];
const HANDLING = ["not_applicable", "stopped_correctly", "recovered", "unresolved", "incorrectly_retried"];
const PROVENANCE = ["raw_rejection", "raw_provider_error", "summary_only", "unavailable"];
const KEYS = ["schema_version", "record_type", "event_id", "event_name", "trace_id", "runtime", "run_id", "observed_at", "recorded_at", "started_at", "ended_at", "tool_name", "tool_call_id", "action_key", "attempt_id", "outcome", "failure_stage", "handling_outcome", "reason_availability", "reason_provenance", "reason_code", "evidence_origin", "verification_status", "production_eligible", "metrics"];
const OPTIONAL = ["server_name", "task_id", "conversation_id", "parent_event_id", "tool_arguments", "tool_result"];
const CAPTURE_KEYS = ["preview", "byte_count", "sha256", "truncated", "omitted", "redacted"];
const PREVIEW_BYTES = 4096;
const BUNDLE_BYTES = 512 * 1024;
const SENSITIVE_KEY = /(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|prompt|system[_-]?message|response[_-]?body|exception|stack|stderr|error|message)/i;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gi;
const SENSITIVE_VALUE = /(?:bearer\s+\S+|(?:sk|ghp|gho|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/gi;

function token(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error("Invalid evidence identifier");
  if (hasSensitiveValue(value)) throw new Error("Sensitive evidence identifier");
  return value;
}
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999)
    throw new Error("Invalid evidence time");
  return new Date(value).toISOString();
}
export function sanitizeTelemetryString(value) {
  return /^(?:[a-z]*error|exception)\s*:/i.test(value) ?
    "[ERROR_REDACTED]" : String(value).replace(PRIVATE_KEY_BLOCK, "[REDACTED]").replace(SENSITIVE_VALUE, "[REDACTED]");
}
function safeValue(value, key, state) {
  if (SENSITIVE_KEY.test(key)) { state.redacted = true; return "[REDACTED]"; }
  if (typeof value === "string") {
    const sanitized = sanitizeTelemetryString(value);
    if (sanitized !== value) state.redacted = true;
    return sanitized;
  }
  if (Array.isArray(value)) return value.map((item) => safeValue(item, "", state));
  if (value instanceof Error) { state.redacted = true; return "[ERROR_REDACTED]"; }
  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const [name, item] of Object.entries(value)) {
      const safeKey = SENSITIVE_KEY.test(name) ? "[REDACTED]" : sanitizeTelemetryString(name);
      if (safeKey !== name) state.redacted = true;
      result[safeKey] = safeValue(item, name, state);
    }
    return result;
  }
  return value;
}
function capture(value, enabled) {
  if (value === undefined) return null;
  const omitted = { preview: null, byte_count: null, sha256: null, truncated: false, omitted: true, redacted: false };
  if (!enabled) return omitted;
  const state = { redacted: false };
  let serialized;
  try { serialized = JSON.stringify(safeValue(value, "", state)); }
  catch { return omitted; }
  if (typeof serialized !== "string") return omitted;
  const bytes = Buffer.from(serialized);
  // Decode at a complete UTF-8 boundary; the preview is metadata, never a second copy of raw content.
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, PREVIEW_BYTES)).replace(/\uFFFD$/u, "");
  return { preview, byte_count: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), truncated: bytes.length > PREVIEW_BYTES, omitted: false, redacted: state.redacted };
}
function hasSensitiveValue(value) {
  PRIVATE_KEY_BLOCK.lastIndex = 0;
  SENSITIVE_VALUE.lastIndex = 0;
  return PRIVATE_KEY_BLOCK.test(value) || SENSITIVE_VALUE.test(value);
}
function validateCapture(value) {
  if (value === null) return;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== CAPTURE_KEYS.length || CAPTURE_KEYS.some((key) => !Object.hasOwn(value, key)))
    throw new Error("Invalid evidence capture fields");
  if (value.omitted === true) {
    if (value.preview !== null || value.byte_count !== null || value.sha256 !== null || value.truncated !== false || value.redacted !== false)
      throw new Error("Invalid evidence capture omission");
    return;
  }
  if (value.omitted !== false || typeof value.preview !== "string" ||
      Buffer.byteLength(value.preview) > PREVIEW_BYTES || !Number.isSafeInteger(value.byte_count) ||
      value.byte_count < Buffer.byteLength(value.preview) || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      typeof value.truncated !== "boolean" || typeof value.redacted !== "boolean" ||
      value.truncated !== (value.byte_count > PREVIEW_BYTES) ||
      /"(?:password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key|cookie|prompt|system[_-]?message|response[_-]?body|exception|stack|stderr|error|message)[^"]*"\s*:/i.test(value.preview) ||
      /(?:^|["'\s])(?:[a-z]*error|exception)\s*:/i.test(value.preview) ||
      hasSensitiveValue(value.preview))
    throw new Error("Invalid or sensitive evidence capture");
  if (!value.truncated && (value.byte_count !== Buffer.byteLength(value.preview) ||
      value.sha256 !== createHash("sha256").update(value.preview).digest("hex")))
    throw new Error("Invalid evidence capture digest");
}
function recordSize(record) {
  let size;
  try { size = Buffer.byteLength(JSON.stringify(record)); }
  catch { throw new Error("Invalid evidence serialization"); }
  if (size >= 1024 * 1024) throw new Error("Evidence event size exceeds 1MB");
  return size;
}
export function opaqueReference(value) {
  return value == null ? null : createHash("sha256").update(String(value)).digest("hex");
}
export function stableEvidenceId(traceId, label) {
  if (!UUID.test(traceId)) throw new Error("Invalid evidence trace ID");
  const hex = createHash("sha256").update(traceId + ":" + label).digest("hex");
  return traceId.slice(0, 14) + "7" + hex.slice(0, 3) + "-8" + hex.slice(3, 6) + "-" + hex.slice(6, 18);
}
/** Strict operation evidence with optional bounded, sanitized tool capture. */
export function evidenceRecord({
  eventName, traceId, eventId, runtime, runId, observedMs = Date.now(), recordedMs = Date.now(),
  startedMs = observedMs, endedMs = null, toolName = null, toolCallId = null, actionKey = null,
  attemptId = null, outcome = "unknown", failureStage = "none", handlingOutcome = "not_applicable",
  reasonAvailability = "not_applicable", reasonProvenance = "unavailable", reasonCode = null,
  evidenceOrigin = "mechanically_captured", verificationStatus = "not_verified", productionEligible = true,
  metrics = null, serverName = null, taskId = null, conversationId = null, parentEventId = null,
  toolArguments, toolResult, captureContent = false,
} = {}) {
  const record = {
    schema_version: 1, record_type: "agent.evidence", event_id: eventId ?? createUuidV7(observedMs),
    event_name: eventName, trace_id: traceId, runtime: token(runtime), run_id: token(runId),
    observed_at: time(observedMs), recorded_at: time(recordedMs),
    started_at: startedMs === null ? null : time(startedMs), ended_at: endedMs === null ? null : time(endedMs),
    tool_name: token(toolName), tool_call_id: token(toolCallId), action_key: token(actionKey),
    attempt_id: token(attemptId), outcome, failure_stage: failureStage,
    handling_outcome: handlingOutcome, reason_availability: reasonAvailability,
    reason_provenance: reasonProvenance, reason_code: token(reasonCode), evidence_origin: evidenceOrigin,
    verification_status: verificationStatus, production_eligible: productionEligible,
    metrics: metrics === null ? null : structuredClone(metrics), server_name: token(serverName),
    task_id: token(taskId), conversation_id: token(conversationId), parent_event_id: parentEventId,
    tool_arguments: capture(toolArguments, captureContent),
    tool_result: capture(toolResult, captureContent && outcome === "succeeded"),
  };
  return validateEvidence(record);
}
export function validateEvidence(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      KEYS.some((key) => !Object.hasOwn(record, key)) ||
      Object.keys(record).some((key) => !KEYS.includes(key) && !OPTIONAL.includes(key)))
    throw new Error("Invalid evidence fields");
  if (record.schema_version !== 1 || record.record_type !== "agent.evidence" ||
      !KINDS.includes(record.event_name) || !UUID.test(record.event_id) || !UUID.test(record.trace_id))
    throw new Error("Invalid evidence identity");
  if (!record.runtime || !record.run_id) throw new Error("Missing evidence identity");
  for (const key of ["runtime", "run_id", "tool_name", "tool_call_id", "action_key", "attempt_id", "reason_code", "server_name", "task_id", "conversation_id"])
    if (Object.hasOwn(record, key)) token(record[key]);
  if (Object.hasOwn(record, "parent_event_id") && record.parent_event_id !== null && !UUID.test(record.parent_event_id))
    throw new Error("Invalid evidence parent ID");
  if (record.parent_event_id === record.event_id) throw new Error("Cyclic evidence parent");
  for (const key of ["tool_arguments", "tool_result"])
    if (Object.hasOwn(record, key)) validateCapture(record[key]);
  if (record.outcome !== "succeeded" &&
      record.tool_result !== undefined && record.tool_result !== null && record.tool_result.omitted !== true)
    throw new Error("Failed operation result capture is not permitted");
  for (const key of ["observed_at", "recorded_at"])
    if (typeof record[key] !== "string" || !Number.isFinite(Date.parse(record[key])) || time(Date.parse(record[key])) !== record[key])
      throw new Error("Invalid evidence timestamp");
  if (record.started_at !== null && (typeof record.started_at !== "string" || !Number.isFinite(Date.parse(record.started_at)) || time(Date.parse(record.started_at)) !== record.started_at))
    throw new Error("Invalid evidence timestamp");
  if (record.ended_at !== null && (typeof record.ended_at !== "string" || !Number.isFinite(Date.parse(record.ended_at)) ||
      time(Date.parse(record.ended_at)) !== record.ended_at || (record.started_at !== null && record.ended_at < record.started_at)))
    throw new Error("Invalid evidence duration");
  if (!OUTCOMES.includes(record.outcome) || !STAGES.includes(record.failure_stage) ||
      !HANDLING.includes(record.handling_outcome) || !PROVENANCE.includes(record.reason_provenance) ||
      !["available", "withheld", "unavailable", "not_applicable"].includes(record.reason_availability) ||
      !["mechanically_captured", "reported_observation", "historical_summary"].includes(record.evidence_origin) ||
      !["not_verified", "verified", "uncertain", "not_applicable"].includes(record.verification_status) ||
      typeof record.production_eligible !== "boolean") throw new Error("Invalid evidence outcome");
  if (record.reason_availability !== "available" && record.reason_code !== null)
    throw new Error("Inconsistent evidence reason");
  if (record.metrics !== null) {
    validateObservabilityRecord(record.metrics);
    if (record.event_name !== "agent.turn.finished" || record.metrics.event_id !== record.trace_id)
      throw new Error("Invalid evidence metrics identity");
  }
  recordSize(record);
  return record;
}
export function validateObservabilityRecord(record) {
  if (record?.record_type !== "agent.trace") {
    const valid = record?.record_type === "agent.evidence" ? validateEvidence(record) : validateEvent(record);
    if (valid.event_name === "agent.turn.completed")
      for (const key of ["runtime", "run_id", "task_id", "agent_id", "model_id", "provider"])
        if (valid[key] !== null && hasSensitiveValue(valid[key]))
          throw new Error("Sensitive telemetry identifier");
    recordSize(valid);
    return valid;
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== 5 ||
      ["schema_version", "record_type", "event_id", "trace_id", "records"].some((key) => !Object.hasOwn(record, key)) ||
      record.schema_version !== 1 || !UUID.test(record.event_id) || record.event_id !== record.trace_id ||
      !Array.isArray(record.records) || record.records.length === 0) throw new Error("Invalid trace bundle");
  let terminals = 0;
  let starts = 0;
  const ids = new Set();
  for (const item of record.records) {
    if (item?.record_type === "agent.trace") throw new Error("Nested trace bundle");
    validateObservabilityRecord(item);
    if ((item.trace_id ?? item.event_id) !== record.trace_id) throw new Error("Mismatched bundle trace");
    if (ids.has(item.event_id)) throw new Error("Duplicate trace bundle event");
    ids.add(item.event_id);
    if (item.event_name === "agent.turn.started") starts++;
    if (item.event_name === "agent.turn.finished" || item.event_name === "agent.turn.completed") terminals++;
  }
  if (starts > 1 || terminals !== 1) throw new Error("Trace bundle requires one terminal and at most one start");
  if (recordSize(record) > BUNDLE_BYTES) throw new Error("Trace bundle exceeds size limit");
  return record;
}
