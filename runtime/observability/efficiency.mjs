import { validateEvidence } from "./evidence.mjs";
import { validateEvent } from "./records.mjs";

function newTurn() {
  return { operations: new Map(), terminal: null, production: false, conflict: false };
}

function turnFor(turns, id) {
  if (!turns.has(id)) turns.set(id, newTurn());
  return turns.get(id);
}

function setTerminal(turn, metrics) {
  if (turn.terminal && JSON.stringify(turn.terminal) !== JSON.stringify(metrics))
    turn.conflict = true;
  turn.terminal = metrics;
}

function recordOperation(turn, record) {
  const key = record.action_key ?? record.tool_call_id ?? record.event_id;
  const prior = turn.operations.get(key);
  const status = record.verification_status;
  if (prior !== undefined && prior !== status) turn.conflict = true;
  else turn.operations.set(key, status);
}

function collectTurns(records, productionOnly) {
  const turns = new Map();
  for (const raw of records) {
    const record = structuredClone(raw);
    if (record?.record_type !== "agent.evidence") {
      validateEvent(record);
      setTerminal(turnFor(turns, record.event_id), record);
      continue;
    }
    validateEvidence(record);
    if (productionOnly && !record.production_eligible) continue;
    const turn = turnFor(turns, record.trace_id);
    if (record.event_name === "agent.operation.observed")
      recordOperation(turn, record);
    if (record.event_name !== "agent.turn.finished") continue;
    if (record.production_eligible) turn.production = true;
    if (record.metrics !== null) setTerminal(turn, record.metrics);
  }
  return turns;
}

function summary() {
  return {
    schema_version: 1, source: "instrumented_telemetry",
    completed_turns: 0, verified_actions: 0, measured_tool_calls: 0,
    reported_tool_failures: 0, measured_duration_ms: 0,
    missing_tool_call_turns: 0, missing_duration_turns: 0,
    completed_turns_without_verified_actions: 0, conflicting_traces: 0,
  };
}

function accumulate(result, turn) {
  const metrics = turn.terminal;
  if (!metrics || metrics.status !== "succeeded") return;
  result.completed_turns++;
  const verified = [...turn.operations.values()].filter(v => v === "verified").length;
  result.verified_actions += verified;
  if (verified === 0) result.completed_turns_without_verified_actions++;
  if (metrics.tool_calls === null) result.missing_tool_call_turns++;
  else result.measured_tool_calls += metrics.tool_calls;
  if (metrics.duration_ms === null) result.missing_duration_turns++;
  else result.measured_duration_ms += metrics.duration_ms;
  if (metrics.tool_failures !== null)
    result.reported_tool_failures += metrics.tool_failures;
}

/**
 * Only measured, instrumented events are analyzed. A verified action denotes
 * a verified observed operation, which may be a read, not necessarily a write.
 */
export function executionEfficiency(records, { productionOnly = true } = {}) {
  if (!Array.isArray(records)) throw new Error("Expected telemetry records array");
  if (typeof productionOnly !== "boolean") throw new Error("Invalid production filter");
  const result = summary();
  for (const turn of collectTurns(records, productionOnly).values()) {
    if (productionOnly && !turn.production) continue;
    if (turn.conflict) { result.conflicting_traces++; continue; }
    accumulate(result, turn);
  }
  result.production_only = productionOnly;
  result.coverage_complete = result.completed_turns > 0 &&
    result.missing_tool_call_turns === 0 &&
    result.missing_duration_turns === 0 &&
    result.completed_turns_without_verified_actions === 0 &&
    result.conflicting_traces === 0;
  result.tool_calls_per_verified_action =
    result.coverage_complete && result.verified_actions > 0 ?
      result.measured_tool_calls / result.verified_actions : null;
  if (result.missing_duration_turns > 0) result.measured_duration_ms = null;
  return result;
}
