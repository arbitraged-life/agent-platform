import test from "node:test";
import assert from "node:assert/strict";
import { turnEvent } from "../../runtime/observability/records.mjs";
import { evidenceRecord } from "../../runtime/observability/evidence.mjs";
import { executionEfficiency } from "../../runtime/observability/efficiency.mjs";

const startedMs = 1700000000000, endedMs = startedMs + 2000;
const m = (overrides = {}) => turnEvent({
  runtime: "fixture", runId: "run", startedMs, endedMs,
  toolCalls: 4, toolFailures: 1, ...overrides,
});
function observed(event, action, status, productionEligible = true) {
  return evidenceRecord({
    eventName: "agent.operation.observed", traceId: event.event_id,
    runtime: "fixture", runId: "run", observedMs: startedMs,
    recordedMs: startedMs, startedMs, endedMs,
    actionKey: action, verificationStatus: status,
    outcome: "succeeded", productionEligible,
  });
}
test("complete measured and verified run produces efficiency", () => {
  const e = m();
  const summary = executionEfficiency([e, observed(e,"one","verified"), observed(e,"two","verified")]);
  assert.equal(summary.tool_calls_per_verified_action, 2);
  assert.equal(summary.reported_tool_failures, 1);
  assert.equal(summary.coverage_complete, true);
});
test("unverified effect never counts as successful completion", () => {
  const e = m();
  const v = executionEfficiency([e, observed(e,"one","not_verified")]);
  assert.equal(v.tool_calls_per_verified_action, null);
  assert.equal(v.completed_turns_without_verified_actions, 1);
});
test("unmeasured calls are unknown, not zero", () => {
  const e = m({toolCalls:null});
  const v = executionEfficiency([e, observed(e,"one","verified")]);
  assert.equal(v.missing_tool_call_turns,1);
  assert.equal(v.coverage_complete,false);
  assert.equal(v.tool_calls_per_verified_action,null);
});
test("nonproduction cases are excluded from operational rates", () => {
  const e = m();
  const op = observed(e,"one","verified",false);
  const v = executionEfficiency([op]);
  assert.equal(v.completed_turns,0);
  assert.equal(v.coverage_complete,false);
});
test("conflicting verification states fail closed", () => {
  const e = m();
  const v = executionEfficiency([e,observed(e,"one","verified"),observed(e,"one","not_verified")]);
  assert.equal(v.conflicting_traces,1);
  assert.equal(v.tool_calls_per_verified_action,null);
});
test("reject arbitrary payload fields", () => {
  assert.throws(()=>executionEfficiency([ {...m(), secret:"value"} ]), /fields/);
});
