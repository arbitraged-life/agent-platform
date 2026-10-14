import { createHash } from "node:crypto";
import { createUuidV7, validateEvent } from "./records.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[a-zA-Z0-9_.:-]{1,128}$/;
const KINDS = ["agent.turn.started", "agent.operation.observed", "agent.turn.finished"];
const OUTCOMES = [
  "started",
  "succeeded",
  "failed",
  "denied",
  "uncertain",
  "suppressed",
  "cancelled",
  "unknown",
];
const STAGES = [
  "none",
  "input_validation",
  "platform_approval",
  "connector_authentication",
  "provider_execution",
  "readback",
  "telemetry_export",
  "shutdown",
  "unknown",
];
const HANDLING = ["not_applicable", "stopped_correctly", "recovered", "unresolved", "incorrectly_retried"];
const PROVENANCE = ["raw_rejection", "raw_provider_error", "summary_only", "unavailable"];
const KEYS = [
  "schema_version",
  "record_type",
  "event_id",
  "event_name",
  "trace_id",
  "runtime",
  "run_id",
  "observed_at",
  "recorded_at",
  "started_at",
  "ended_at",
  "tool_name",
  "tool_call_id",
  "action_key",
  "attempt_id",
  "outcome",
  "failure_stage",
  "handling_outcome",
  "reason_availability",
  "reason_provenance",
  "reason_code",
  "evidence_origin",
  "verification_status",
  "production_eligible",
  "metrics",
];

function token(value) {
  if (value == null) return null;
  if (typeof value !== "string" || !TOKEN.test(value)) throw new Error("Invalid evidence identifier");
  return value;
}
function time(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999)
    throw new Error("Invalid evidence time");
  return new Date(value).toISOString();
}
export function opaqueReference(value) {
  return value == null ? null : createHash("sha256").update(String(value)).digest("hex");
}
export function stableEvidenceId(traceId, label) {
  if (!UUID.test(traceId)) throw new Error("Invalid evidence trace ID");
  const hex = createHash("sha256")
    .update(traceId + ":" + label)
    .digest("hex");
  return traceId.slice(0, 14) + "7" + hex.slice(0, 3) + "-8" + hex.slice(3, 6) + "-" + hex.slice(6, 18);
}
/** A separate strict contract: never carries arguments, text, paths or raw error bodies. */
export function evidenceRecord({
  eventName,
  traceId,
  eventId,
  runtime,
  runId,
  observedMs = Date.now(),
  recordedMs = Date.now(),
  startedMs = observedMs,
  endedMs = null,
  toolName = null,
  toolCallId = null,
  actionKey = null,
  attemptId = null,
  outcome = "unknown",
  failureStage = "none",
  handlingOutcome = "not_applicable",
  reasonAvailability = "not_applicable",
  reasonProvenance = "unavailable",
  reasonCode = null,
  evidenceOrigin = "mechanically_captured",
  verificationStatus = "not_verified",
  productionEligible = true,
  metrics = null,
} = {}) {
  const record = {
    schema_version: 1,
    record_type: "agent.evidence",
    event_id: eventId ?? createUuidV7(observedMs),
    event_name: eventName,
    trace_id: traceId,
    runtime: token(runtime),
    run_id: token(runId),
    observed_at: time(observedMs),
    recorded_at: time(recordedMs),
    started_at: time(startedMs),
    ended_at: endedMs === null ? null : time(endedMs),
    tool_name: token(toolName),
    tool_call_id: token(toolCallId),
    action_key: token(actionKey),
    attempt_id: token(attemptId),
    outcome,
    failure_stage: failureStage,
    handling_outcome: handlingOutcome,
    reason_availability: reasonAvailability,
    reason_provenance: reasonProvenance,
    reason_code: token(reasonCode),
    evidence_origin: evidenceOrigin,
    verification_status: verificationStatus,
    production_eligible: productionEligible,
    metrics: metrics === null ? null : structuredClone(metrics),
  };
  return validateEvidence(record);
}
export function validateEvidence(record) {
  if (
    !record ||
    Object.keys(record).length !== KEYS.length ||
    KEYS.some((key) => !Object.hasOwn(record, key))
  )
    throw new Error("Invalid evidence fields");
  if (
    record.schema_version !== 1 ||
    record.record_type !== "agent.evidence" ||
    !KINDS.includes(record.event_name) ||
    !UUID.test(record.event_id) ||
    !UUID.test(record.trace_id)
  )
    throw new Error("Invalid evidence identity");
  if (!record.runtime || !record.run_id) throw new Error("Missing evidence identity");
  for (const key of [
    "runtime",
    "run_id",
    "tool_name",
    "tool_call_id",
    "action_key",
    "attempt_id",
    "reason_code",
  ])
    token(record[key]);
  for (const key of ["observed_at", "recorded_at", "started_at"])
    if (typeof record[key] !== "string" || time(Date.parse(record[key])) !== record[key])
      throw new Error("Invalid evidence timestamp");
  if (
    record.ended_at !== null &&
    (time(Date.parse(record.ended_at)) !== record.ended_at || record.ended_at < record.started_at)
  )
    throw new Error("Invalid evidence duration");
  if (
    !OUTCOMES.includes(record.outcome) ||
    !STAGES.includes(record.failure_stage) ||
    !HANDLING.includes(record.handling_outcome) ||
    !PROVENANCE.includes(record.reason_provenance) ||
    !["available", "withheld", "unavailable", "not_applicable"].includes(record.reason_availability) ||
    !["mechanically_captured", "reported_observation", "historical_summary"].includes(
      record.evidence_origin,
    ) ||
    !["not_verified", "verified", "uncertain", "not_applicable"].includes(record.verification_status) ||
    typeof record.production_eligible !== "boolean"
  )
    throw new Error("Invalid evidence outcome");
  if (record.reason_availability !== "available" && record.reason_code !== null)
    throw new Error("Inconsistent evidence reason");
  if (record.metrics !== null) {
    validateEvent(record.metrics);
    if (record.event_name !== "agent.turn.finished" || record.metrics.event_id !== record.trace_id)
      throw new Error("Invalid evidence metrics identity");
  }
  return record;
}
export function validateObservabilityRecord(record) {
  return record?.record_type === "agent.evidence" ? validateEvidence(record) : validateEvent(record);
}
