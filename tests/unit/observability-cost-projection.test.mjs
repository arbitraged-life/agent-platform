import test from 'node:test';
import assert from 'node:assert/strict';
import { turnEvent } from '../../runtime/observability/records.mjs';
import { opikRecords } from '../../runtime/observability/opik.mjs';

const timing = { startedMs: 1700000000000, endedMs: 1700000001500 };
const event = (usage = {}) => turnEvent({ runtime: 'omp', runId: 'fixture-run', ...timing, usage });

test('known producer cost is projected to the supported Opik cost field', () => {
  const original = event({ input: 200, output: 20, total: 1020, cacheRead: 800, costUsd: 0.05 });
  const { trace, span } = opikRecords(original, 'fixture');
  assert.equal(span.total_estimated_cost, 0.05);
  assert.equal(span.metadata.usage.cost_usd, 0.05);
  assert.deepEqual(trace.metadata.usage, original.usage);
});

test('cache and reasoning remain separate while reported totals stay authoritative', () => {
  const { span } = opikRecords(event({ input: 200, output: 20, total: 1050, cacheRead: 800, cacheWrite: 10, reasoning: 30 }), 'fixture');
  assert.deepEqual(span.usage, { prompt_tokens: 200, completion_tokens: 20, total_tokens: 1050, reasoning_tokens: 30, cache_read_tokens: 800, cache_write_tokens: 10 });
});

test('unknown cost and token classes are omitted, not converted to zero', () => {
  const { span } = opikRecords(event(), 'fixture');
  assert.equal(Object.hasOwn(span, 'total_estimated_cost'), false);
  assert.equal(Object.hasOwn(span, 'usage'), false);
  assert.equal(span.metadata.usage.cost_usd, null);
  assert.equal(span.metadata.usage.cache_read_tokens, null);
});

test('reported zero cost and cached usage remain explicit zeroes', () => {
  const { span } = opikRecords(event({ input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0 }), 'fixture');
  assert.equal(span.total_estimated_cost, 0);
  assert.equal(span.usage.cache_read_tokens, 0);
  assert.equal(span.usage.reasoning_tokens, 0);
});

test('cost projection preserves producer identity and does not mutate its event', () => {
  const original = event({ total: 500, costUsd: 0.004 });
  const before = structuredClone(original);
  const first = opikRecords(original, 'fixture');
  const second = opikRecords(original, 'fixture');
  assert.deepEqual(original, before);
  assert.equal(first.span.id, second.span.id);
  assert.equal(first.span.total_estimated_cost, original.usage.cost_usd);
  assert.equal(first.trace.id, original.event_id);
  assert.equal(Object.hasOwn(first.span, 'input'), false);
  assert.equal(Object.hasOwn(first.span, 'output'), false);
});
