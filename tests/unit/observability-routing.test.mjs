import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createUuidV7, turnEvent } from '../../runtime/observability/records.mjs';
import { evidenceRecord } from '../../runtime/observability/evidence.mjs';
import { createTelemetryDelivery, readTelemetryUsage } from '../../runtime/observability/routing.mjs';
import { createOtlpExporter, mapOtlpRecord, otelTraceId } from '../../runtime/observability/otlp.mjs';
import { deliveryRecord, validateDeliveryRecord } from '../../runtime/observability/delivery.mjs';

const started = 1700000000000;
const traceId = createUuidV7(started);
const period = { period_start: '2023-11-01T00:00:00.000Z', period_end: '2023-12-01T00:00:00.000Z', allowance: 50, other_usage: 0 };
const clock = () => started;
const config = (mode = 'mirror', honeycomb = 50, logfire = 50) => ({ schema_version: 1, mode, sinks: { honeycomb: { ...period, allowance: honeycomb }, logfire: { ...period, allowance: logfire } } });
const root = (id = traceId) => turnEvent({ runtime: 'fixture', runId: 'run', startedMs: started, endedMs: started + 1200, eventId: id });
const operation = (id = traceId, ms = started + 100) => evidenceRecord({ eventName: 'agent.operation.observed', traceId: id, eventId: createUuidV7(ms), runtime: 'fixture', runId: 'run', observedMs: ms, startedMs: ms, endedMs: ms + 20, toolName: 'read', outcome: 'succeeded' });
const start = (id = traceId) => evidenceRecord({ eventName: 'agent.turn.started', traceId: id, eventId: createUuidV7(started + 1), runtime: 'fixture', runId: 'run', observedMs: started, outcome: 'started' });
const finish = (id = traceId) => evidenceRecord({ eventName: 'agent.turn.finished', traceId: id, eventId: createUuidV7(started + 1200), runtime: 'fixture', runId: 'run', observedMs: started + 1200, startedMs: started, endedMs: started + 1200, outcome: 'succeeded' });
async function directory(t) { const dir = await mkdtemp(path.join(os.tmpdir(), 'telemetry-route-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
function fixtures() {
  const sent = [];
  const exporter = name => async (record, { acceptedRecords = [] } = {}) => {
    sent.push({ name, record, acceptedRecords });
    const mapped = mapOtlpRecord(record), id = otelTraceId(record.trace_id ?? record.event_id);
    return {
      delivery_status: 'accepted', retryable: false,
      accepted_records: [
        ...(mapped.spans.length ? [`spans:${id}`] : []),
        ...(mapped.logs.length ? [`logs:${id}`] : []),
      ],
      billable_counts: {
        accepted_spans: mapped.spans.length, accepted_logs: mapped.logs.length,
        rejected_spans: 0, rejected_logs: 0,
      },
    };
  };
  return { sent, exporters: { honeycomb: exporter('honeycomb'), logfire: exporter('logfire') } };
}

test('buffer holds an incomplete trace durably and mirror sends identical completed bundle to both sinks after restart', async t => {
  const directory = await directoryFor(t);
  const { sent, exporters } = fixtures();
  const first = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  assert.equal((await first(start())).delivery_status, 'pending');
  assert.equal((await first(operation())).delivery_status, 'pending');
  assert.equal(sent.length, 0);
  const second = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  const terminal = finish();
  const receipt = await second(terminal);
  assert.equal(receipt.delivery_status, 'accepted');
  assert.deepEqual(sent.map(x => x.name), ['honeycomb', 'logfire']);
  assert.deepEqual(sent[0].record, sent[1].record);
  assert.deepEqual(sent[0].record.records.map(x => x.event_name), ['agent.turn.started', 'agent.operation.observed', 'agent.turn.finished']);
  await second(terminal);
  assert.equal(sent.length, 2);
});
async function directoryFor(t) { return directory(t); }

test('split uses whole-trace capacity, returns explicit shortfall, retains blocked bundle and persists assignment after policy change', async t => {
  const directory = await directoryFor(t), { sent, exporters } = fixtures();
  const routed = createTelemetryDelivery({ directory, configuration: config('split', 2, 0), exporters, now: clock });
  await routed(operation());
  assert.equal((await routed(root())).route, 'honeycomb');
  assert.deepEqual(sent.map(x => x.name), ['honeycomb']);
  const changed = createTelemetryDelivery({ directory, configuration: config('mirror', 10, 10), exporters, now: clock });
  assert.equal((await changed(operation(traceId, started + 300))).route, 'honeycomb');
  assert.deepEqual(sent.map(x => x.name), ['honeycomb', 'honeycomb']);
  const id2 = createUuidV7(started + 8000);
  const blocked = createTelemetryDelivery({ directory, configuration: config('split', 0, 0), exporters, now: clock });
  const result = await blocked(root(id2));
  assert.equal(result.delivery_status, 'capacity_blocked');
  assert.deepEqual(blocked.getAdmission(id2), { persisted: true, state: 'ready', trace_id: id2 });
  assert.ok(result.shortfall.honeycomb > 0 && result.shortfall.logfire > 0);
  assert.equal(result.combined_shortfall.trace_fraction, 1);
  assert.equal(blocked.getUsage().honeycomb.blocked, 1);
  assert.equal(blocked.getUsage().honeycomb.observed, 4);
  assert.equal(readTelemetryUsage({ directory }).sinks.logfire[0].blocked, 1);
  assert.equal(sent.length, 2);
  const reopened = createTelemetryDelivery({ directory, configuration: config('split', 10, 10), exporters, now: clock });
  assert.equal((await reopened.drain())[0].delivery_status, 'accepted');
  assert.equal(reopened.getUsage().honeycomb.blocked, 0);
  assert.equal(sent.length, 3);
});

test('mirror shortage cannot be canceled by peer surplus; split reports capacity needed at one whole-trace destination', async t => {
  const { exporters } = fixtures();
  const mirror = createTelemetryDelivery({ directory: await directoryFor(t),
    configuration: config('mirror', 0, 50), exporters, now: clock });
  const blockedMirror = await mirror(root());
  assert.equal(blockedMirror.delivery_status, 'capacity_blocked');
  assert.equal(blockedMirror.shortfall.honeycomb, 1);
  assert.equal(blockedMirror.shortfall.logfire, 0);
  assert.equal(blockedMirror.combined_shortfall.trace_fraction, 1);
  const split = createTelemetryDelivery({ directory: await directoryFor(t),
    configuration: config('split', 1, 1), exporters, now: clock });
  const indivisible = { schema_version: 1, record_type: 'agent.trace', event_id: traceId, trace_id: traceId,
    records: [root(), operation()] };
  const blockedSplit = await split(indivisible);
  assert.equal(blockedSplit.delivery_status, 'capacity_blocked');
  assert.equal(blockedSplit.shortfall.honeycomb, 1);
  assert.equal(blockedSplit.shortfall.logfire, 1);
  assert.equal(blockedSplit.combined_shortfall.trace_fraction, 0.5);
  assert.equal(blockedSplit.combined_shortfall.honeycomb_units, 1);
  assert.equal(blockedSplit.combined_shortfall.logfire_units, 1);
});

test('split admits an active sink despite an inactive peer and never reassigns its trace', async t => {
  const directory = await directoryFor(t), { exporters, sent } = fixtures();
  const allocation = config('split', 2, 2);
  allocation.sinks.logfire.period_start = '2023-12-01T00:00:00.000Z';
  allocation.sinks.logfire.period_end = '2024-01-01T00:00:00.000Z';
  const initial = createTelemetryDelivery({ directory, configuration: allocation, exporters, now: clock });
  assert.equal((await initial(root())).route, 'honeycomb');
  assert.deepEqual(sent.map(item => item.name), ['honeycomb']);
  const next = config('split', 2, 2);
  next.sinks.logfire.period_start = '2023-12-01T00:00:00.000Z';
  next.sinks.logfire.period_end = '2024-01-01T00:00:00.000Z';
  const late = operation(traceId, started + 300);
  const inactive = createTelemetryDelivery({ directory, configuration: next, exporters,
    now: () => Date.parse('2023-12-02T00:00:00.000Z') });
  const blocked = await inactive(late);
  assert.equal(blocked.delivery_status, 'capacity_blocked');
  assert.equal(blocked.route, 'honeycomb');
  assert.deepEqual(sent.map(item => item.name), ['honeycomb']);
  next.sinks.honeycomb.period_start = '2023-12-01T00:00:00.000Z';
  next.sinks.honeycomb.period_end = '2024-01-01T00:00:00.000Z';
  const later = createTelemetryDelivery({ directory, configuration: next, exporters,
    now: () => Date.parse('2023-12-02T00:00:00.000Z') });
  assert.equal((await later(late)).route, 'honeycomb');
  assert.deepEqual(sent.map(item => item.name), ['honeycomb', 'honeycomb']);
});

test('routing configuration shapes ignore property order but reject unknown keys', async t => {
  const directory = await directoryFor(t), { exporters } = fixtures();
  const ordered = { mode: 'split', sinks: {
    logfire: { other_usage: 0, allowance: 2, period_end: period.period_end, period_start: period.period_start },
    honeycomb: { other_usage: 0, allowance: 2, period_end: period.period_end, period_start: period.period_start },
  }, schema_version: 1 };
  assert.equal((await createTelemetryDelivery({ directory, configuration: ordered, exporters, now: clock })(root())).route, 'honeycomb');
  assert.throws(() => createTelemetryDelivery({ directory, configuration: {
    ...ordered, sinks: { ...ordered.sinks, unexpected: ordered.sinks.honeycomb },
  }, exporters, now: clock }), /configuration/);
  assert.throws(() => createTelemetryDelivery({ directory, configuration: {
    ...ordered, sinks: { ...ordered.sinks, honeycomb: { ...ordered.sinks.honeycomb, unexpected: 1 } },
  }, exporters, now: clock }), /capacity|exporter/);
});

test('readonly queue accounting distinguishes admitted traces from capacity-blocked traces', async t => {
  const directory = await directoryFor(t), { exporters } = fixtures();
  const delivery = createTelemetryDelivery({ directory, configuration: config('mirror', 0, 0), exporters, now: clock });
  await delivery.admit(root());
  await delivery.flushPersistence();
  const admitted = readTelemetryUsage({ directory });
  assert.equal(admitted.pending_traces, 1);
  assert.equal(admitted.blocked_traces, 0);
  assert.equal((await delivery.drain())[0].delivery_status, 'capacity_blocked');
  const blocked = readTelemetryUsage({ directory });
  assert.equal(blocked.pending_traces, 0);
  assert.equal(blocked.blocked_traces, 1);
  const resumed = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  assert.equal((await resumed.drain())[0].delivery_status, 'accepted');
  const completed = readTelemetryUsage({ directory });
  assert.equal(completed.pending_traces, 0);
  assert.equal(completed.blocked_traces, 0);
});

test('independent acknowledgements retry only known rejection and retain counters after outbox eviction', async t => {
  const directory = await directoryFor(t), sent = [];
  let rejectOnce = true;
  const exporters = { honeycomb: async (record) => { sent.push(['honeycomb', record.event_id]); return { delivery_status: 'accepted', retryable: false, accepted_records: ['spans:trace'], billable_counts: { accepted_spans: 1, accepted_logs: 0 } }; }, logfire: async (record) => { sent.push(['logfire', record.event_id]); if (rejectOnce) { rejectOnce = false; return { delivery_status: 'failed', retryable: true, reason_code: 'HTTP_429', accepted_records: [] }; } return { delivery_status: 'accepted', retryable: false, accepted_records: ['spans:trace'], billable_counts: { accepted_spans: 1, accepted_logs: 0 } }; } };
  let time = started;
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: () => time });
  await delivery(root());
  time += 61000;
  await delivery.drain();
  assert.equal((await delivery(root())).delivery_status, 'accepted');
  assert.deepEqual(sent.map(x => x[0]), ['honeycomb', 'logfire', 'logfire']);
  const usage = delivery.getUsage();
  assert.equal(usage.honeycomb.accepted, 1);
  assert.equal(usage.logfire.attempted, 2);
  assert.equal(usage.logfire.failed, 1);
  await rm(path.join(directory, 'outbox', traceId + '.json'));
  assert.equal(readTelemetryUsage({ directory }).sinks.honeycomb[0].observed, 1);
  assert.equal(readTelemetryUsage({ directory }).sinks.logfire[0].accepted, 1);
  assert.equal(createTelemetryDelivery({ directory, configuration: config(), exporters, now: () => time }).getUsage().honeycomb.accepted, 1);
  assert.equal((await createTelemetryDelivery({ directory, configuration: config(), exporters, now: () => time })(root())).delivery_status, 'accepted');
});

test('aggregate delivery preserves an authentication denial', async t => {
  const directory = await directoryFor(t), { exporters } = fixtures();
  exporters.honeycomb = async () => ({
    delivery_status: 'denied', retryable: false, reason_code: 'HTTP_403', accepted_records: [],
  });
  const receipt = await createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock })(root());
  assert.equal(receipt.destinations.honeycomb.delivery_status, 'denied');
  assert.equal(receipt.delivery_status, 'denied');
});

test('unknown quota fails closed, bounded pending buffer rejects explicitly, and delivery schema accepts a single configured sink', async t => {
  const directory = await directoryFor(t), { exporters } = fixtures();
  assert.throws(() => createTelemetryDelivery({ directory, configuration: config('mirror', null, 1), exporters, now: clock }), /configuration|capacity|budget/);
  const bounded = createTelemetryDelivery({ directory, configuration: { ...config(), max_pending_bytes: 1024 }, exporters, now: clock });
  await bounded(start());
  await assert.rejects(() => bounded(operation()), /capacity|buffer/i);
  const event = root(), timestamp = new Date(started).toISOString();
  const record = deliveryRecord(event, { observed_at: timestamp, recorded_at: timestamp, destinations: { honeycomb: { delivery_status: 'accepted', retryable: false } } });
  assert.equal(validateDeliveryRecord(record), record);
});

test('billing windows keep isolated reservations and external baseline never decreases across recreation', async t => {
  const directory = await directoryFor(t), { exporters } = fixtures();
  let time = started;
  const first = createTelemetryDelivery({ directory, configuration: config('split', 2, 2), exporters, now: () => time });
  await first(root());
  assert.equal(first.getUsage().honeycomb.reserved, 1);
  const budget = config('split', 2, 2);
  budget.sinks.honeycomb.other_usage = 1;
  createTelemetryDelivery({ directory, configuration: budget, exporters, now: () => time });
  const reopened = createTelemetryDelivery({ directory, configuration: config('split', 2, 2), exporters, now: () => time });
  assert.equal(reopened.getUsage().honeycomb.other_usage, 1);
  assert.equal(reopened.getUsage().honeycomb.available, 0);
  time = Date.parse('2023-12-02T00:00:00.000Z');
  const next = config('split', 2, 2);
  for (const sink of Object.values(next.sinks)) {
    sink.period_start = '2023-12-01T00:00:00.000Z';
    sink.period_end = '2024-01-01T00:00:00.000Z';
  }
  const second = createTelemetryDelivery({ directory, configuration: next, exporters, now: () => time });
  await second(root(createUuidV7(time)));
  assert.equal(second.getUsage().honeycomb.reserved, 1);
  const history = readTelemetryUsage({ directory });
  assert.equal(history.sinks.honeycomb.length, 2);
  assert.equal(history.sinks.honeycomb[1].other_usage, 1);
});

test('slow sink network cannot block subsequent evidence admission or flushPersistence', async t => {
  const directory = await directoryFor(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const exporters = {
    honeycomb: async () => { await held; return { delivery_status: 'accepted', accepted_records: [], retryable: false }; },
    logfire: async () => ({ delivery_status: 'accepted', accepted_records: [], retryable: false }),
  };
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  const first = delivery(root());
  const nextId = createUuidV7(started + 5000);
  const staged = delivery(start(nextId));
  assert.equal((await staged).delivery_status, 'pending');
  await delivery.flushPersistence();
  assert.deepEqual(delivery.getAdmission(traceId), { persisted: true, state: 'ready', trace_id: traceId });
  assert.equal(readTelemetryUsage({ directory }).pending_traces, 1);
  release();
  await first;
});

test('recreated outbox marks interrupted attempted sink uncertain without replay', async t => {
  const directory = await directoryFor(t), requests = [];
  const exporters = {
    honeycomb: async () => { requests.push('honeycomb'); return { delivery_status: 'accepted', retryable: false, accepted_records: [] }; },
    logfire: async () => { requests.push('logfire'); return { delivery_status: 'failed', retryable: true, accepted_records: [], reason_code: 'HTTP_429' }; },
  };
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  await delivery(root());
  const filename = path.join(directory, 'outbox', traceId + '.json');
  const row = JSON.parse(await readFile(filename, 'utf8'));
  row.state = 'in_flight';
  row.attempts = 2;
  const state = new DatabaseSync(path.join(directory, 'routing.sqlite'));
  state.prepare('INSERT INTO sink_attempts(bundle_id,sink,attempt) VALUES(?,?,?)').run(traceId, 'logfire', 2);
  state.close();
  await writeFile(filename, JSON.stringify(row));
  const resumed = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  assert.equal((await resumed.drain())[0].outbox_status, 'interrupted');
  assert.equal(resumed.getUsage().logfire.uncertain, 1);
  assert.deepEqual(requests, ['honeycomb', 'logfire']);
});

test('unattributable partial signal rejection is counted as dropped and never automatically replayed', async t => {
  const directory = await directoryFor(t), calls = { honeycomb: 0, logfire: 0 };
  const exporters = {
    honeycomb: async () => {
      calls.honeycomb++;
      return { delivery_status: 'failed', retryable: false, accepted_records: ['spans:trace'],
        billable_counts: { accepted_spans: 1, accepted_logs: 0, rejected_spans: 1, rejected_logs: 0 } };
    },
    logfire: async () => {
      calls.logfire++;
      return { delivery_status: 'accepted', retryable: false, accepted_records: ['spans:trace'],
        billable_counts: { accepted_spans: 2, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0 } };
    },
  };
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  await delivery(operation());
  const receipt = await delivery(root());
  assert.equal(receipt.delivery_status, 'failed');
  assert.equal(delivery.getUsage().honeycomb.dropped, 1);
  assert.equal(delivery.getUsage().honeycomb.accepted, 1);
  await delivery.drain();
  assert.deepEqual(calls, { honeycomb: 1, logfire: 1 });
});

test('late unknown-timing tool log keeps persisted trace assignment across policy change', async t => {
  const directory = await directoryFor(t), { sent, exporters } = fixtures();
  await createTelemetryDelivery({ directory, configuration: config('split', 1, 1), exporters, now: clock })(root());
  const resumed = createTelemetryDelivery({ directory, configuration: config('mirror', 10, 10), exporters, now: clock });
  const unknown = evidenceRecord({
    eventName: 'agent.operation.observed', traceId, eventId: createUuidV7(started + 900),
    runtime: 'fixture', runId: 'run', observedMs: started + 900, startedMs: null,
    endedMs: null, toolName: 'read', outcome: 'succeeded',
  });
  const receipt = await resumed(unknown);
  assert.equal(receipt.route, 'honeycomb');
  assert.deepEqual(sent.map(x => x.name), ['honeycomb', 'honeycomb']);
  assert.equal(mapOtlpRecord(sent[1].record).logs.length, 1);
  assert.equal(mapOtlpRecord(sent[1].record).spans.length, 0);
});

test('complete source bundle proves durable admission before destination capacity is available', async t => {
  const directory = await directoryFor(t), { sent, exporters } = fixtures();
  const bundle = { schema_version: 1, record_type: 'agent.trace', event_id: traceId, trace_id: traceId, records: [root()] };
  const blocked = createTelemetryDelivery({ directory, configuration: config('mirror', 0, 0), exporters, now: clock });
  assert.equal((await blocked(bundle)).delivery_status, 'capacity_blocked');
  await blocked.flushPersistence();
  assert.deepEqual(blocked.getAdmission(traceId), { persisted: true, state: 'ready', trace_id: traceId });
  assert.equal(blocked.getUsage().honeycomb.observed, 1);
  const resumed = createTelemetryDelivery({ directory, configuration: config('mirror', 10, 10), exporters, now: clock });
  assert.equal((await resumed(bundle)).delivery_status, 'accepted');
  assert.equal(sent.length, 2);
  assert.equal(resumed.getUsage().honeycomb.observed, 1);
  assert.equal(resumed.getAdmission(traceId).state, 'done');
});

test('blocked trace delivered in next period retains original source-demand attribution', async t => {
  const directory = await directoryFor(t), { exporters } = fixtures();
  let time = started;
  const bundle = { schema_version: 1, record_type: 'agent.trace', event_id: traceId, trace_id: traceId, records: [root()] };
  const first = createTelemetryDelivery({ directory, configuration: config('mirror', 0, 0), exporters, now: () => time });
  assert.equal((await first(bundle)).delivery_status, 'capacity_blocked');
  time = Date.parse('2023-12-02T00:00:00.000Z');
  const next = config('mirror', 10, 10);
  for (const sink of Object.values(next.sinks)) {
    sink.period_start = '2023-12-01T00:00:00.000Z';
    sink.period_end = '2024-01-01T00:00:00.000Z';
  }
  const resumed = createTelemetryDelivery({ directory, configuration: next, exporters, now: () => time });
  assert.equal((await resumed(bundle)).delivery_status, 'accepted');
  assert.equal(resumed.getUsage().honeycomb.observed, 0);
  assert.equal(resumed.getUsage().honeycomb.attempted, 1);
  const history = readTelemetryUsage({ directory }).sinks.honeycomb;
  assert.equal(history[1].observed, 1);
  assert.equal(history[1].blocked, 0);
});

test('retry blocked at period rollover does not consume outbox attempts or reroute an accepted peer', async t => {
  const directory = await directoryFor(t), requests = [];
  let time = started, deny = true;
  const exporters = {
    honeycomb: async () => { requests.push('honeycomb'); return { delivery_status: 'accepted', retryable: false, accepted_records: [] }; },
    logfire: async () => {
      requests.push('logfire');
      if (deny) { deny = false; return { delivery_status: 'failed', retryable: true, accepted_records: [] }; }
      return { delivery_status: 'accepted', retryable: false, accepted_records: [] };
    },
  };
  await createTelemetryDelivery({ directory, configuration: config('mirror', 1, 1), exporters, now: () => time })(root());
  time = Date.parse('2023-12-02T00:00:00.000Z');
  const next = config('mirror', 0, 0);
  for (const sink of Object.values(next.sinks)) {
    sink.period_start = '2023-12-01T00:00:00.000Z';
    sink.period_end = '2024-01-01T00:00:00.000Z';
  }
  const blocked = createTelemetryDelivery({ directory, configuration: next, exporters, now: () => time });
  assert.equal((await blocked.drain())[0].delivery_status, 'capacity_blocked');
  assert.equal(JSON.parse(await readFile(path.join(directory, 'outbox', traceId + '.json'), 'utf8')).attempts, 1);
  assert.equal(blocked.getUsage().logfire.attempted, 0);
  for (const sink of Object.values(next.sinks)) sink.allowance = 10;
  const resumed = createTelemetryDelivery({ directory, configuration: next, exporters, now: () => time });
  assert.equal((await resumed.drain())[0].delivery_status, 'accepted');
  assert.deepEqual(requests, ['honeycomb', 'logfire', 'logfire']);
  assert.equal(resumed.getUsage().logfire.attempted, 1);
});

test('period expires after first sink acceptance without losing its acknowledgement or stranding peer', async t => {
  const directory = await directoryFor(t), requests = [];
  let time = started;
  const exporters = {
    honeycomb: async () => {
      requests.push('honeycomb');
      time = Date.parse('2023-12-02T00:00:00.000Z');
      return { delivery_status: 'accepted', retryable: false, accepted_records: [] };
    },
    logfire: async () => {
      requests.push('logfire');
      return { delivery_status: 'accepted', retryable: false, accepted_records: [] };
    },
  };
  const delivery = createTelemetryDelivery({ directory, configuration: config('mirror', 1, 1), exporters, now: () => time });
  const result = await delivery(root());
  assert.equal(result.delivery_status, 'capacity_blocked');
  assert.deepEqual(requests, ['honeycomb']);
  const next = config('mirror', 10, 10);
  for (const sink of Object.values(next.sinks)) {
    sink.period_start = '2023-12-01T00:00:00.000Z';
    sink.period_end = '2024-01-01T00:00:00.000Z';
  }
  time += 61000;
  const resumed = createTelemetryDelivery({ directory, configuration: next, exporters, now: () => time });
  assert.equal((await resumed.drain())[0].delivery_status, 'accepted');
  assert.deepEqual(requests, ['honeycomb', 'logfire']);
});

test('OTLP 429 on spans counts only the dispatched signal, never the unsent logs', async t => {
  const directory = await directoryFor(t), requests = [];
  let time = started;
  const honeycomb = createOtlpExporter({
    schema_version: 1, destination: 'honeycomb', endpoint: 'https://api.honeycomb.io',
    credential_env: 'TOKEN', service_name: 'fixture',
  }, {
    environment: { TOKEN: 'fixture' },
    fetcher: async url => {
      requests.push(url);
      return requests.length === 1 ? new Response('', { status: 429 }) :
        new Response('{}', { status: 200 });
    },
  });
  const unknown = evidenceRecord({
    eventName: 'agent.operation.observed', traceId, eventId: createUuidV7(started + 50),
    runtime: 'fixture', runId: 'run', observedMs: started + 50, startedMs: null,
    endedMs: null, toolName: 'read', outcome: 'succeeded',
  });
  const complete = finish();
  const bundle = { schema_version: 1, record_type: 'agent.trace', event_id: traceId, trace_id: traceId,
    records: [unknown, complete] };
  const delivery = createTelemetryDelivery({ directory, configuration: config('split', 10, 0),
    exporters: { honeycomb, logfire: async () => assert.fail('split peer dispatched') }, now: () => time });
  assert.equal((await delivery(bundle)).delivery_status, 'failed');
  assert.equal(delivery.getUsage().honeycomb.observed, 2);
  assert.equal(delivery.getUsage().honeycomb.attempted, 1);
  assert.equal(delivery.getUsage().honeycomb.failed, 1);
  assert.equal(requests.length, 1);
  time += 61000;
  assert.equal((await delivery.drain())[0].delivery_status, 'accepted');
  assert.equal(delivery.getUsage().honeycomb.attempted, 3);
  assert.equal(requests.length, 3);
});

test('drain recovers a complete terminal left pending by an earlier interrupted admission', async t => {
  const directory = await directoryFor(t), { sent, exporters } = fixtures();
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  const startedRecord = start(), terminalRecord = finish();
  await delivery.admit(startedRecord);
  const serialized = JSON.stringify(terminalRecord);
  const db = new DatabaseSync(path.join(directory, 'routing.sqlite'));
  db.prepare('INSERT INTO events(event_id,trace_id,digest,payload,state) VALUES(?,?,?,?,?)')
    .run(terminalRecord.event_id, traceId, createHash('sha256').update(serialized).digest('hex'), serialized, 'pending');
  db.close();
  const resumed = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  assert.equal((await resumed.drain())[0].delivery_status, 'accepted');
  assert.deepEqual(sent[0].record.records.map(record => record.event_name),
    ['agent.turn.started', 'agent.turn.finished']);
  assert.equal(readTelemetryUsage({ directory }).pending_traces, 0);
});

test('completing root bundle does not erase a related operation staged during slow export', async t => {
  const directory = await directoryFor(t);
  let entered, release;
  const inNetwork = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const exporters = {
    honeycomb: async () => {
      entered();
      await held;
      return { delivery_status: 'accepted', retryable: false, accepted_records: [] };
    },
    logfire: async () => ({ delivery_status: 'accepted', retryable: false, accepted_records: [] }),
  };
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  const rootResult = delivery(root());
  await inNetwork;
  const late = operation(traceId, started + 300);
  assert.equal((await delivery.admit(late)).state, 'ready');
  release();
  await rootResult;
  assert.equal(delivery.getAdmission(late.event_id).state, 'ready');
  assert.equal((await delivery.drain())[0].delivery_status, 'accepted');
  assert.equal(delivery.getAdmission(late.event_id).state, 'done');
});

test('replaying one late event dispatches its own ready bundle when another is also ready', async t => {
  const directory = await directoryFor(t), { sent, exporters } = fixtures();
  const delivery = createTelemetryDelivery({ directory, configuration: config(), exporters, now: clock });
  await delivery(root());
  const first = operation(traceId, started + 300), second = operation(traceId, started + 400);
  await delivery.admit(first);
  await delivery.admit(second);
  assert.equal((await delivery(second)).event_id, second.event_id);
  assert.deepEqual(sent.slice(2).map(item => item.record.event_id), [second.event_id, second.event_id]);
  assert.equal(delivery.getAdmission(first.event_id).state, 'ready');
  assert.equal(delivery.getAdmission(second.event_id).state, 'done');
});

test('bounded drain rotates beyond an oversized blocked trace to deliver a later fitting trace', async t => {
  const directory = await directoryFor(t), { sent, exporters } = fixtures();
  const first = createTelemetryDelivery({ directory, configuration: config('split', 0, 0), exporters, now: clock });
  const large = { schema_version: 1, record_type: 'agent.trace', event_id: traceId, trace_id: traceId,
    records: [operation(), root()] };
  const secondId = createUuidV7(started + 5000);
  const small = { schema_version: 1, record_type: 'agent.trace', event_id: secondId, trace_id: secondId,
    records: [root(secondId)] };
  await first.admit(large);
  await first.admit(small);
  const resumed = createTelemetryDelivery({ directory, configuration: config('split', 1, 0), exporters, now: clock });
  assert.equal((await resumed.drain({ limit: 1 }))[0].delivery_status, 'capacity_blocked');
  assert.equal((await resumed.drain({ limit: 1 }))[0].delivery_status, 'accepted');
  assert.equal(sent[0].record.trace_id, secondId);
  assert.equal(resumed.getAdmission(traceId).state, 'ready');
});
