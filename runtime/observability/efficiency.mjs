import { validateEvidence } from "./evidence.mjs";
import { validateEvent } from "./records.mjs";

/**
 * Analyze only instrumented operations. One verified action key represents
 * one independently confirmed effect; never infer it from successful calls.
 */
export function executionEfficiency(records, { productionOnly = true } = {}) {
  if (!Array.isArray(records)) throw new Error("Expected telemetry records array");
  const turns = new Map();
  for (const raw of records) {
    const record = structuredClone(raw);
    if (record?.record_type === "agent.evidence") {
      validateEvidence(record);
      if (productionOnly && !record.production_eligible) continue;
      const id = record.trace_id;
      if (!turns.has(id)) turns.set(id, { operations: new Map(), terminal: null, production: false, conflict: false });
      const turn = turns.get(id);
      if (record.event_name === "agent.turn.finished" && record.production_eligible) turn.production = true;
      if (record.event_name === "agent.operation.observed") {
        const key = record.action_key ?? record.tool_call_id ?? record.event_id;
        const prior = turn.operations.get(key);
        const state = record.verification_status;
        if (prior !== undefined && prior !== state) turn.conflict = true;
        else turn.operations.set(key, state);
      }
      if (record.event_name === "agent.turn.finished" && record.metrics) {
        if (turn.terminal && JSON.stringify(turn.terminal) !== JSON.stringify(record.metrics))
          turn.conflict = true;
        turn.terminal = record.metrics;
      }
    } else {
      validateEvent(record);
      if (!turns.has(record.event_id))
        turns.set(record.event_id, { operations: new Map(), terminal: record, production: false, conflict: false });
      else {
        const turn = turns.get(record.event_id);
        if (turn.terminal && JSON.stringify(turn.terminal) !== JSON.stringify(record))
          turn.conflict = true;
        turn.terminal = record;
      }
    }
  }
  let eligibleTurns = 0, verifiedActions = 0, measuredCalls = 0, failures = 0, duration = 0;
  let unknownCalls = 0, unknownDuration = 0, inconsistent = 0, unverifiedTurns = 0;
  for (const turn of turns.values()) {
    if (productionOnly && !turn.production) continue;
    if (turn.conflict) { inconsistent++; continue; }
    const m = turn.terminal;
    if (!m || m.status !== "succeeded") continue;
    eligibleTurns++;
    const verified = [...turn.operations.values()].filter(v => v === "verified").length;
    verifiedActions += verified;
    if (!verified) unverifiedTurns++;
    if (m.tool_calls === null) unknownCalls++;
    else measuredCalls += m.tool_calls;
    if (m.duration_ms === null) unknownDuration++;
    else duration += m.duration_ms;
    if (m.tool_failures !== null) failures += m.tool_failures;
  }
  const coverageComplete = unknownCalls === 0 && inconsistent === 0 &&
    unverifiedTurns === 0 && eligibleTurns > 0;
  return {
    schema_version: 1,
    source: "instrumented_telemetry",
    production_only: productionOnly,
    completed_turns: eligibleTurns,
    verified_actions: verifiedActions,
    measured_tool_calls: measuredCalls,
    reported_tool_failures: failures,
    measured_duration_ms: unknownDuration ? null : duration,
    missing_tool_call_turns: unknownCalls,
    missing_duration_turns: unknownDuration,
    completed_turns_without_verified_actions: unverifiedTurns,
    conflicting_traces: inconsistent,
    coverage_complete: coverageComplete,
    tool_calls_per_verified_action: coverageComplete && verifiedActions > 0 ?
      measuredCalls / verifiedActions : null,
  };
}
