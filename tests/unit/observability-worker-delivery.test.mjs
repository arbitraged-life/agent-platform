import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createWorkerTelemetryDelivery } from '../../runtime/observability/worker-delivery.mjs';
import { evidenceRecord, stableEvidenceId } from '../../runtime/observability/evidence.mjs';
import { createUuidV7 } from '../../runtime/observability/records.mjs';
import { acceptedReceipt, DeliveryError } from '../../runtime/observability/delivery.mjs';

const start = Date.parse('2026-10-01T00:00:00.000Z');
const now = Date.parse('2026-10-31T12:00:00.000Z');
const config = (mode = 'mirror', allowance = 20) => ({ schema_version: 1, mode, sinks: {
  honeycomb: { period_start: '2026-10-01T00:00:00.000Z', period_end: '2026-11-01T00:00:00.000Z', allowance, other_usage: 0 },
  logfire: { period_start: '2026-10-01T00:00:00.000Z', period_end: '2026-11-01T00:00:00.000Z', allowance, other_usage: 0 },
} });
const bundle = (label = 'a') => {
  const traceId = createUuidV7(start + label.charCodeAt(0));
  const record = evidenceRecord({ eventName: 'agent.operation.observed', traceId,
    eventId: stableEvidenceId(traceId, 'operation'), runtime: 'ai-gateway', runId: label,
    toolName: 'email.decision', observedMs: start + 1024, recordedMs: start + 1024,
    startedMs: start, endedMs: start + 1024, outcome: 'succeeded', captureContent: false });
  const terminal = evidenceRecord({ eventName: 'agent.turn.finished', traceId,
    eventId: stableEvidenceId(traceId, 'finished'), runtime: 'ai-gateway', runId: label,
    observedMs: start + 1024, recordedMs: start + 1024,
    startedMs: start, endedMs: start + 1024, outcome: 'succeeded' });
  return { schema_version: 1, record_type: 'agent.trace', event_id: traceId, trace_id: traceId, records: [record, terminal] };
};
const storage = () => {
  const db = new DatabaseSync(':memory:');
  return { sql: { exec(query, ...params) { const rows = query.trim().split(';').filter(Boolean);
    if (rows.length > 1) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    if (/^\s*SELECT/i.test(query)) return { toArray: () => statement.all(...params) };
    statement.run(...params); return { toArray: () => [] };
  } }, transactionSync(action) { db.exec('BEGIN'); try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; } } };
};
const receipt = record => acceptedReceipt(record.event_id, [`spans:${record.trace_id.replaceAll('-', '')}`]);
const setup = (store, configuration = config(), exporters = {}) => createWorkerTelemetryDelivery({
  storage: store, configuration, now: () => now, retryDelayMs: 1000,
  exporters: { honeycomb: async record => receipt(record), logfire: async record => receipt(record), ...exporters },
});

test('one whole trace is routed before either network write; identical retry never resends accepted destinations', async () => {
  const store = storage(), seen = [], event = bundle();
  const deliver = setup(store, config(), {
    honeycomb: async record => { seen.push(['honeycomb', record.event_id]); return receipt(record); },
    logfire: async record => { seen.push(['logfire', record.event_id]); return receipt(record); },
  });
  assert.equal((await deliver(event)).delivery_status, 'accepted');
  assert.deepEqual(seen, [['honeycomb', event.event_id], ['logfire', event.event_id]]);
  assert.equal((await setup(store)(event)).delivery_status, 'accepted');
  assert.equal(seen.length, 2);
  assert.equal(deliver.usage().honeycomb.accepted, 2);
  assert.equal(deliver.usage().logfire.accepted, 2);
});

test('unknown transport and interrupted in-flight sink stay uncertain; other sink can complete after restart', async () => {
  const store = storage(), event = bundle('b');
  const first = setup(store, config(), { honeycomb: async () => { throw Error('lost response'); } });
  assert.equal((await first(event)).delivery_status, 'uncertain');
  let retried = 0;
  const second = setup(store, config(), { honeycomb: async () => { retried++; throw Error('replayed'); } });
  const result = await second(event);
  assert.equal(result.destinations.honeycomb.delivery_status, 'uncertain');
  assert.equal(result.destinations.logfire.delivery_status, 'accepted');
  assert.equal(retried, 0);
});

test('ambiguous exporter exception accounts planned attempted and uncertain units only once', async () => {
  const store = storage(), event = bundle('z');
  const deliver = setup(store, config(), { honeycomb: async () => { throw Error('lost response'); } });
  const first = await deliver(event);
  assert.equal(first.destinations.honeycomb.delivery_status, 'uncertain');
  assert.equal(deliver.usage().honeycomb.attempted, 2);
  assert.equal(deliver.usage().honeycomb.uncertain, 2);
  await deliver(event);
  assert.equal(deliver.usage().honeycomb.attempted, 2);
  assert.equal(deliver.usage().honeycomb.uncertain, 2);
});

test('exception after a signal checkpoint counts only the still-ambiguous attempted signal', async () => {
  const store = storage(), event = bundle('u'), trace = event.trace_id.replaceAll('-', '');
  event.records[0].started_at = null;
  event.records[0].ended_at = null;
  const honeycomb = async (record, { onSignal }) => {
    const progress = { ...acceptedReceipt(record.event_id, [`spans:${trace}`]),
      delivery_status: 'pending', signal_outcomes: { spans: { status: 'accepted' } } };
    await onSignal({ signal: 'spans', status: 'accepted', receipt: progress,
      billable_counts: { attempted_spans: 1, attempted_logs: 0, accepted_spans: 1,
        accepted_logs: 0, rejected_spans: 0, rejected_logs: 0 } });
    throw Error('lost log response');
  };
  const deliver = setup(store, config(), { honeycomb });
  const first = await deliver(event);
  assert.equal(first.destinations.honeycomb.delivery_status, 'uncertain');
  assert.equal(deliver.usage().honeycomb.attempted, 2);
  assert.equal(deliver.usage().honeycomb.accepted, 1);
  assert.equal(deliver.usage().honeycomb.uncertain, 1);
});

test('unresolved delivery retains buffer capacity rather than discarding its only canonical payload', async () => {
  const store = storage();
  const deliver = createWorkerTelemetryDelivery({
    storage: store, configuration: config(), now: () => now, maxEntries: 1,
    exporters: { honeycomb: async () => { throw Error('response lost'); },
      logfire: async record => receipt(record) },
  });
  assert.equal((await deliver(bundle('q'))).delivery_status, 'uncertain');
  await assert.rejects(() => deliver(bundle('r')), /full|capacity/i);
});

test('full durable queue drains due retry before rejecting a new whole trace', async () => {
  const store = storage(), first = bundle('j'), second = bundle('k');
  let clock = now, honeycombCalls = 0;
  const delivery = createWorkerTelemetryDelivery({
    storage: store, configuration: config('mirror', 4), now: () => clock,
    maxEntries: 1, retryDelayMs: 1000,
    exporters: {
      honeycomb: async record => {
        if (++honeycombCalls === 1) throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
        return receipt(record);
      },
      logfire: async record => receipt(record),
    },
  });
  assert.equal((await delivery(first)).destinations.honeycomb.reason_code, 'HTTP_429');
  assert.equal(delivery.nextAttemptAt(), now + 1000);
  clock += 1000;
  assert.equal((await delivery(second)).delivery_status, 'accepted');
  assert.equal(honeycombCalls, 3);
  assert.equal(delivery.usage().honeycomb.accepted, 4);
  assert.equal(delivery.usage().logfire.accepted, 4);
});

test('simultaneous full-buffer recovery shares the due export claim', async () => {
  const store = storage(), first = bundle('l'), second = bundle('m'), third = bundle('o');
  let clock = now, honeycombCalls = 0, release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const delivery = createWorkerTelemetryDelivery({
    storage: store, configuration: config('mirror', 6), now: () => clock,
    maxEntries: 1, retryDelayMs: 1000,
    exporters: {
      honeycomb: async record => {
        honeycombCalls++;
        if (honeycombCalls === 1) throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
        if (record.event_id === first.event_id) { started(); await held; }
        return receipt(record);
      },
      logfire: async record => receipt(record),
    },
  });
  await delivery(first);
  clock += 1000;
  const recover = delivery(second);
  await begun;
  const competing = delivery(third);
  release();
  const [admitted, rejected] = await Promise.allSettled([recover, competing]);
  assert.equal(admitted.status, 'fulfilled');
  assert.equal(admitted.value.delivery_status, 'accepted');
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason.code, 'BUFFER_FULL');
  assert.equal(honeycombCalls, 3); // Initial 429, shared retry, newly admitted second trace.
  assert.equal(delivery.usage().honeycomb.uncertain, 0);
  assert.equal(delivery.usage().logfire.uncertain, 0);
});

test('full queue reaches a later due trace when earlier retries remain buffered', async () => {
  const store = storage(), size = 102, last = size - 1;
  let clock = now, ready = false;
  const delivery = createWorkerTelemetryDelivery({
    storage: store, configuration: config('mirror', size * 2 + 2), now: () => clock,
    maxEntries: size, retryDelayMs: 1000,
    exporters: {
      honeycomb: async record => {
        if ((record.records[0].run_id !== `run${last}` || !ready) &&
            record.records[0].run_id !== `run${size}`)
          throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
        return receipt(record);
      },
      logfire: async record => receipt(record),
    },
  });
  const trace = index => {
    const id = createUuidV7(start + 1000 + index);
    const records = [
      evidenceRecord({ eventName: 'agent.operation.observed', traceId: id,
        eventId: stableEvidenceId(id, 'operation'), runtime: 'ai-gateway', runId: `run${index}`,
        toolName: 'email.decision', observedMs: start + 1024, recordedMs: start + 1024,
        startedMs: start, endedMs: start + 1024, outcome: 'succeeded' }),
      evidenceRecord({ eventName: 'agent.turn.finished', traceId: id,
        eventId: stableEvidenceId(id, 'finished'), runtime: 'ai-gateway', runId: `run${index}`,
        observedMs: start + 1024, recordedMs: start + 1024,
        startedMs: start, endedMs: start + 1024, outcome: 'succeeded' }),
    ];
    return { schema_version: 1, record_type: 'agent.trace', event_id: id, trace_id: id, records };
  };
  for (let index = 0; index < size; index++) await delivery(trace(index));
  clock += 1000;
  ready = true;
  assert.equal((await delivery(trace(size))).delivery_status, 'accepted');
  assert.equal(delivery.usage().honeycomb.uncertain, 0);
});

test('explicit 429 is retryable without repeating the already-accepted peer', async () => {
  const store = storage(), event = bundle('c');
  let calls = 0, clock = now;
  const exporters = { honeycomb: async record => {
    calls++;
    if (calls === 1) throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
    return receipt(record);
  } };
  const make = () => createWorkerTelemetryDelivery({ storage: store, configuration: config(), now: () => clock,
    retryDelayMs: 1000, exporters: { ...exporters, logfire: async record => receipt(record) } });
  assert.equal((await make()(event)).destinations.honeycomb.retryable, true);
  assert.equal(calls, 1);
  assert.equal((await make().drain()).length, 0);
  clock += 1000;
  assert.equal((await make().drain())[0].delivery_status, 'accepted');
  assert.equal(calls, 2);
  assert.equal(make().usage().logfire.accepted, 2);
});

test('signal checkpoint commits before peer delivery and never counts an unattempted log', async () => {
  const store = storage(), event = bundle('w'), trace = event.trace_id.replaceAll('-', '');
  event.records[0].started_at = null;
  event.records[0].ended_at = null;
  let peerCalls = 0, observedCheckpoint, observedPeerCalls;
  const rejected = new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
  const honeycomb = async (record, { onSignal }) => {
    const progress = { ...rejected.receipt, signal_outcomes: { spans: 'failed' },
      has_partial_rejection: false, accepted_records: [] };
    await onSignal({ signal: 'spans', status: 'failed', accepted_records: [],
      billable_counts: { attempted_spans: 1, attempted_logs: 0,
        accepted_spans: 0, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0 }, receipt: progress });
    const persisted = store.sql.exec('SELECT receipts FROM telemetry_events WHERE event_id=?', event.event_id).toArray()[0];
    observedCheckpoint = JSON.parse(persisted.receipts).honeycomb.reason_code;
    observedPeerCalls = peerCalls;
    throw rejected;
  };
  const deliver = setup(store, config(), { honeycomb,
    logfire: async record => { peerCalls++; return receipt(record); } });
  await deliver(event);
  assert.equal(observedCheckpoint, 'HTTP_429');
  assert.equal(observedPeerCalls, 0);
  assert.equal(deliver.usage().honeycomb.attempted, 1);
  assert.equal(deliver.usage().honeycomb.failed, 1);
  assert.equal(deliver.usage().honeycomb.accepted, 0);
  assert.equal(peerCalls, 1);
});

test('partial span rejection remains durable when logs are 429 then accepted on retry', async () => {
  const store = storage(), event = bundle('x'), trace = event.trace_id.replaceAll('-', '');
  event.records[0].started_at = null;
  event.records[0].ended_at = null;
  let clock = now, attempts = 0, peerCalls = 0, retryAccepted, retryPartial, retryRejected;
  const span = `spans:${trace}`, log = `logs:${trace}`;
  const empty = { attempted_spans: 0, attempted_logs: 0,
    accepted_spans: 0, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0 };
  const honeycomb = async (record, { acceptedRecords, previousReceipt, onSignal }) => {
    attempts++;
    if (attempts === 1) {
      const rejected = { ...acceptedReceipt(record.event_id, [span]), delivery_status: 'pending',
        has_partial_rejection: true, signal_outcomes: { spans: { rejected: 1 } } };
      await onSignal({ signal: 'spans', status: 'failed', accepted_records: [span],
        billable_counts: { ...empty, attempted_spans: 1, rejected_spans: 1 }, receipt: rejected });
      const pending = { ...rejected, reason_code: 'HTTP_429', retryable: true,
        signal_outcomes: { spans: { rejected: 1 }, logs: { rejected: 0 } } };
      await onSignal({ signal: 'logs', status: 'failed', accepted_records: [span],
        billable_counts: { ...empty, attempted_logs: 1 }, receipt: pending });
      const error = new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true,
        acceptedRecords: [span] });
      error.receipt = { ...error.receipt, ...pending, delivery_status: 'failed' };
      throw error;
    }
    retryAccepted = acceptedRecords;
    retryPartial = previousReceipt.has_partial_rejection;
    retryRejected = previousReceipt.signal_outcomes.spans.rejected;
    const pending = { ...acceptedReceipt(record.event_id, [span, log]), delivery_status: 'pending',
      has_partial_rejection: true, signal_outcomes: { ...previousReceipt.signal_outcomes, logs: { rejected: 0 } } };
    await onSignal({ signal: 'logs', status: 'accepted', accepted_records: [span, log],
      billable_counts: { ...empty, attempted_logs: 1, accepted_logs: 1 }, receipt: pending });
    const error = new DeliveryError({ code: 'EXPORT_FAILED', status: 'failed', acceptedRecords: [span, log] });
    error.receipt = { ...error.receipt, ...pending, delivery_status: 'failed', retryable: false };
    throw error;
  };
  const logfire = async record => { peerCalls++; return receipt(record); };
  const create = () => createWorkerTelemetryDelivery({ storage: store, configuration: config(),
    now: () => clock, retryDelayMs: 1000, exporters: { honeycomb, logfire } });
  assert.equal((await create()(event)).destinations.honeycomb.retryable, true);
  assert.equal(create().usage().honeycomb.dropped, 1);
  clock += 1000;
  const final = await create().drain();
  assert.deepEqual(retryAccepted, [span]);
  assert.equal(retryPartial, true);
  assert.equal(retryRejected, 1);
  assert.equal(final[0].destinations.honeycomb.has_partial_rejection, true);
  assert.equal(final[0].delivery_status, 'failed');
  assert.equal(create().usage().honeycomb.accepted, 1);
  assert.equal(create().usage().honeycomb.attempted, 3);
  assert.equal(peerCalls, 1);
  assert.equal(attempts, 2);
});
test('abandoned in-flight claim is ambiguous after restart and never resent', async () => {
  const store = storage(), event = bundle('z');
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const first = setup(store, config(), { honeycomb: async () => { await stalled; return receipt(event); } });
  const pending = first(event);
  // send() persisted its claim synchronously before handing control to the external fetch.
  await Promise.resolve();
  let replays = 0;
  const restart = setup(store, config(), {
    honeycomb: async () => { replays++; return receipt(event); },
  });
  const resumed = await restart(event);
  assert.equal(resumed.destinations.honeycomb.delivery_status, 'uncertain');
  assert.equal(resumed.destinations.logfire.delivery_status, 'accepted');
  assert.equal(replays, 0);
  release();
  await pending;
  assert.equal((await restart(event)).destinations.honeycomb.delivery_status, 'uncertain');
});

test('restart preserves acknowledged span and marks only the unconfirmed signal uncertain', async () => {
  const store = storage(), event = bundle('m'), trace = event.trace_id.replaceAll('-', '');
  event.records[0].started_at = null;
  event.records[0].ended_at = null;
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const first = setup(store, config(), { honeycomb: async (record, { onSignal }) => {
    await onSignal({ signal: 'spans', status: 'accepted', accepted_records: [`spans:${trace}`],
      billable_counts: { attempted_spans: 1, attempted_logs: 0,
        accepted_spans: 1, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0 },
      receipt: { ...acceptedReceipt(record.event_id, [`spans:${trace}`]),
        delivery_status: 'pending', signal_outcomes: { spans: { status: 'accepted' } },
        billable_counts: { attempted_spans: 1, attempted_logs: 0,
          accepted_spans: 1, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0 } } });
    await stalled;
    return acceptedReceipt(record.event_id, [`spans:${trace}`]);
  } });
  const pending = first(event);
  await Promise.resolve();
  let replays = 0;
  const restart = setup(store, config(), { honeycomb: async () => { replays++; return receipt(event); } });
  const uncertain = await restart(event);
  assert.deepEqual(uncertain.destinations.honeycomb.accepted_records, [`spans:${trace}`]);
  assert.equal(restart.usage().honeycomb.attempted, 1);
  assert.equal(restart.usage().honeycomb.accepted, 1);
  assert.equal(restart.usage().honeycomb.uncertain, 1);
  assert.equal(replays, 0);
  release();
  await pending;
});

test('simultaneous submissions in one Durable Object instance share the same claim', async () => {
  const store = storage(), event = bundle('y');
  let calls = 0;
  const deliver = setup(store, config(), { honeycomb: async record => {
    calls++;
    await Promise.resolve();
    return receipt(record);
  } });
  const receipts = await Promise.all([deliver(event), deliver(event)]);
  assert.equal(receipts[0].delivery_status, 'accepted');
  assert.deepEqual(receipts[0], receipts[1]);
  assert.equal(calls, 1);
});

test('distinct traces persist admissions without waiting for another vendor response', async () => {
  const store = storage(), firstEvent = bundle('1'), secondEvent = bundle('2');
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const deliver = setup(store, config('mirror', 4), {
    honeycomb: async record => record.event_id === firstEvent.event_id ? stalled : receipt(record),
  });
  const pending = deliver(firstEvent);
  const other = await deliver(secondEvent);
  assert.equal(other.delivery_status, 'accepted');
  assert.equal(deliver.usage().honeycomb.observed, 4);
  assert.equal(deliver.usage().honeycomb.accepted, 2);
  release(receipt(firstEvent));
  assert.equal((await pending).delivery_status, 'accepted');
});

test('OTLP partial rejection is retained without replay of its signal', async () => {
  const store = storage(), event = bundle('d');
  let calls = 0;
  const deliver = setup(store, config(), { honeycomb: async record => {
    calls++;
    throw Object.assign(new DeliveryError({ code: 'EXPORT_FAILED' }), { receipt: {
      delivery_status: 'failed', retryable: false, accepted_records: [`spans:${record.trace_id.replaceAll('-', '')}`],
      billable_counts: { accepted_spans: 1, rejected_spans: 1, accepted_logs: 0, rejected_logs: 0 },
    } });
  } });
  const first = await deliver(event);
  assert.equal(first.destinations.honeycomb.delivery_status, 'failed');
  assert.equal(first.destinations.honeycomb.billable_counts.rejected_spans, 1);
  const repeated = await setup(store, config(), { honeycomb: async record => {
    calls++;
    return receipt(record);
  } })(event);
  assert.equal(repeated.destinations.honeycomb.delivery_status, 'failed');
  assert.equal(calls, 1);
  assert.equal(deliver.usage().honeycomb.dropped, 1);
});

test('capacity uncertainty, expiry and bounded queue fail closed before network', async () => {
  const store = storage(); let calls = 0;
  const exporters = { honeycomb: async () => { calls++; }, logfire: async () => { calls++; } };
  const full = setup(store, config('mirror', 1), exporters);
  assert.equal((await full(bundle('e'))).delivery_status, 'capacity_blocked');
  assert.equal(calls, 0);
  assert.equal((await full.drain()).length, 0);
  assert.throws(() => setup(storage(), { ...config(), sinks: { ...config().sinks, honeycomb: { ...config().sinks.honeycomb, other_usage: -1 } } }), /capacity/i);
  const expired = createWorkerTelemetryDelivery({ storage: storage(), configuration: config(), now: () => Date.parse('2026-11-02'), exporters });
  assert.equal((await expired(bundle('f'))).delivery_status, 'capacity_blocked');
  assert.equal(calls, 0);
  const limited = createWorkerTelemetryDelivery({ storage: storage(), configuration: config('mirror', 1), now: () => now, exporters, maxEntries: 1 });
  await limited(bundle('g'));
  await assert.rejects(() => limited(bundle('h')), /queue capacity/i);
});

test('observed and blocked demand survives a verified same-period allowance increase', async () => {
  const store = storage(), event = bundle('n');
  const blocked = setup(store, config('mirror', 1));
  assert.equal((await blocked(event)).delivery_status, 'capacity_blocked');
  assert.equal(blocked.usage().honeycomb.observed, 2);
  assert.equal(blocked.usage().honeycomb.blocked, 2);
  const updated = setup(store, config('mirror', 3));
  assert.equal(updated.nextAttemptAt(), now + 1);
  assert.equal((await updated.drain())[0].delivery_status, 'accepted');
  assert.equal(updated.usage().honeycomb.observed, 2);
  assert.equal(updated.usage().honeycomb.blocked, 2);
  assert.equal(updated.usage().honeycomb.accepted, 2);
});

test('increased outside usage pauses a previously reserved retry until reviewed allowance grows', async () => {
  const store = storage(), event = bundle('v'); let calls = 0, clock = now;
  const honeycomb = async record => {
    calls++;
    if (calls === 1) throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
    return receipt(record);
  };
  const create = configuration => createWorkerTelemetryDelivery({ storage: store, configuration,
    now: () => clock, retryDelayMs: 1000,
    exporters: { honeycomb, logfire: async record => receipt(record) } });
  const first = create(config('mirror', 2));
  await first(event);
  clock += 1000;
  const reduced = config('mirror', 2);
  reduced.sinks.honeycomb.other_usage = 1;
  const guarded = create(reduced);
  assert.equal((await guarded(event)).delivery_status, 'capacity_blocked');
  assert.equal(guarded.usage().honeycomb.blocked, 2);
  assert.equal(calls, 1);
  reduced.sinks.honeycomb.allowance = 3;
  const refreshed = create(reduced);
  assert.equal((await refreshed(event)).delivery_status, 'accepted');
  assert.equal(calls, 2);
});

test('overlapping revised billing periods cannot reset already-reserved capacity', async () => {
  const store = storage();
  await setup(store, config('split', 2))(bundle('q'));
  const revised = config('split', 2);
  revised.sinks.honeycomb.period_end = '2026-11-02T00:00:00.000Z';
  assert.throws(() => setup(store, revised), /overlap/i);
});

test('known 429 retries remaining signal next month only after explicit new-period capacity', async () => {
  const store = storage(), event = bundle('r');
  let clock = now, calls = 0, peerCalls = 0;
  const exporter = async record => {
    calls++;
    if (calls === 1) throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
    return receipt(record);
  };
  const logfire = async record => { peerCalls++; return receipt(record); };
  const october = createWorkerTelemetryDelivery({ storage: store, configuration: config(),
    now: () => clock, exporters: { honeycomb: exporter, logfire } });
  await october(event);
  const november = config('mirror', 1);
  for (const sink of Object.values(november.sinks)) {
    sink.period_start = '2026-11-01T00:00:00.000Z';
    sink.period_end = '2026-12-01T00:00:00.000Z';
  }
  clock = Date.parse('2026-11-02T00:00:00.000Z');
  const blocked = createWorkerTelemetryDelivery({ storage: store, configuration: november,
    now: () => clock, exporters: { honeycomb: exporter, logfire } });
  assert.equal((await blocked(event)).delivery_status, 'capacity_blocked');
  assert.equal(blocked.nextAttemptAt(), null);
  assert.equal(blocked.usage().honeycomb.blocked, 2);
  assert.equal(blocked.usage().honeycomb.observed, 0);
  assert.equal(october.usage().honeycomb.observed, 2);
  assert.equal(calls, 1);
  november.sinks.honeycomb.allowance = 2;
  const resumed = createWorkerTelemetryDelivery({ storage: store, configuration: november,
    now: () => clock, exporters: { honeycomb: exporter, logfire } });
  assert.equal((await resumed(event)).delivery_status, 'accepted');
  assert.equal(resumed.usage().honeycomb.accepted, 2);
  assert.equal(resumed.usage().logfire.accepted, 0);
  assert.equal(october.usage().logfire.accepted, 2);
  assert.equal(peerCalls, 1);
  assert.equal(calls, 2);
});

test('new-period retry carries accepted signal keys so only the remaining signal is exported', async () => {
  const store = storage(), event = bundle('s'), trace = event.trace_id.replaceAll('-', '');
  event.records[0].started_at = null;
  event.records[0].ended_at = null;
  let clock = now, calls = 0, peerCalls = 0, seenAccepted;
  const honeycomb = async (record, { acceptedRecords = [] } = {}) => {
    calls++;
    if (calls === 1) {
      const error = new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true,
        acceptedRecords: [`spans:${trace}`] });
      error.receipt.billable_counts = {
        accepted_spans: 1, accepted_logs: 0, rejected_spans: 0, rejected_logs: 0,
      };
      throw error;
    }
    seenAccepted = acceptedRecords;
    return acceptedReceipt(record.event_id, [...acceptedRecords, `logs:${trace}`]);
  };
  const logfire = async record => { peerCalls++; return receipt(record); };
  const october = createWorkerTelemetryDelivery({ storage: store, configuration: config(),
    now: () => clock, exporters: { honeycomb, logfire } });
  await october(event);
  const november = config('mirror', 1);
  for (const sink of Object.values(november.sinks)) {
    sink.period_start = '2026-11-01T00:00:00.000Z';
    sink.period_end = '2026-12-01T00:00:00.000Z';
  }
  clock = Date.parse('2026-11-02T00:00:00.000Z');
  const resumed = createWorkerTelemetryDelivery({ storage: store, configuration: november,
    now: () => clock, exporters: { honeycomb, logfire } });
  assert.equal((await resumed(event)).delivery_status, 'accepted');
  assert.deepEqual(seenAccepted, [`spans:${trace}`]);
  assert.equal(resumed.usage().honeycomb.accepted, 1);
  assert.equal(october.usage().honeycomb.accepted, 1);
  assert.equal(resumed.usage().logfire.accepted, 0);
  assert.equal(calls, 2);
  assert.equal(peerCalls, 1);
});

test('split picks exactly one entire trace and counts reserved monthly units across restart', async () => {
  const store = storage(), destinations = [];
  const exporters = { honeycomb: async record => { destinations.push('honeycomb'); return receipt(record); },
    logfire: async record => { destinations.push('logfire'); return receipt(record); } };
  const deliver = setup(store, config('split', 2), exporters);
  assert.equal((await deliver(bundle('i'))).route, 'honeycomb');
  assert.equal((await setup(store, config('split', 2), exporters)(bundle('j'))).route, 'logfire');
  assert.deepEqual(destinations, ['honeycomb', 'logfire']);
  assert.equal((await deliver(bundle('k'))).delivery_status, 'capacity_blocked');
});

test('split admits either active sink independently of its inactive peer', async () => {
  const store = storage(), event = bundle('x'), destinations = [];
  const exporters = {
    honeycomb: async record => { destinations.push('honeycomb'); return receipt(record); },
    logfire: async record => { destinations.push('logfire'); return receipt(record); },
  };
  const october = config('split', 10);
  october.sinks.logfire.period_start = '2026-11-01T00:00:00.000Z';
  october.sinks.logfire.period_end = '2026-12-01T00:00:00.000Z';
  const send = createWorkerTelemetryDelivery({ storage: store, configuration: october, now: () => now, exporters });
  assert.equal((await send(event)).route, 'honeycomb');
  assert.deepEqual(destinations, ['honeycomb']);
  const late = bundle('y'), reserve = config('split', 0);
  reserve.sinks.honeycomb.period_start = '2026-11-01T00:00:00.000Z';
  reserve.sinks.honeycomb.period_end = '2026-12-01T00:00:00.000Z';
  reserve.sinks.logfire.period_start = '2026-10-01T00:00:00.000Z';
  reserve.sinks.logfire.period_end = '2026-11-01T00:00:00.000Z';
  reserve.sinks.logfire.allowance = 10;
  const second = createWorkerTelemetryDelivery({ storage: store, configuration: reserve, now: () => now, exporters });
  assert.equal((await second(late)).route, 'logfire');
  assert.deepEqual(destinations, ['honeycomb', 'logfire']);
});

test('split retry stays with its assigned sink when only the other sink is active', async () => {
  const store = storage(), event = bundle('v'), destinations = [];
  let clock = now, rejected = true;
  const exporters = {
    honeycomb: async record => {
      destinations.push('honeycomb');
      if (rejected) {
        rejected = false;
        throw new DeliveryError({ code: 'HTTP_429', httpStatus: 429, retryable: true });
      }
      return receipt(record);
    },
    logfire: async record => { destinations.push('logfire'); return receipt(record); },
  };
  const october = config('split', 10);
  october.sinks.logfire.period_start = '2026-11-01T00:00:00.000Z';
  october.sinks.logfire.period_end = '2026-12-01T00:00:00.000Z';
  const first = createWorkerTelemetryDelivery({ storage: store, configuration: october,
    now: () => clock, exporters, retryDelayMs: 1000 });
  assert.equal((await first(event)).route, 'honeycomb');
  clock = Date.parse('2026-11-02T00:00:00.000Z');
  const unavailable = createWorkerTelemetryDelivery({ storage: store, configuration: october,
    now: () => clock, exporters, retryDelayMs: 1000 });
  const blocked = await unavailable(event);
  assert.equal(blocked.delivery_status, 'capacity_blocked');
  assert.equal(blocked.route, 'honeycomb');
  assert.equal(unavailable.nextAttemptAt(), null);
  assert.deepEqual(destinations, ['honeycomb']);
  const november = config('split', 10);
  for (const sink of Object.values(november.sinks)) {
    sink.period_start = '2026-11-01T00:00:00.000Z';
    sink.period_end = '2026-12-01T00:00:00.000Z';
  }
  const resumed = createWorkerTelemetryDelivery({ storage: store, configuration: november,
    now: () => clock, exporters, retryDelayMs: 1000 });
  assert.equal((await resumed(event)).route, 'honeycomb');
  assert.deepEqual(destinations, ['honeycomb', 'honeycomb']);
});

test('Worker configuration shape is order-insensitive and rejects unknown fields', async () => {
  const ordered = { mode: 'split', sinks: {
    logfire: { other_usage: 0, allowance: 2, period_end: '2026-11-01T00:00:00.000Z',
      period_start: '2026-10-01T00:00:00.000Z' },
    honeycomb: { other_usage: 0, allowance: 2, period_end: '2026-11-01T00:00:00.000Z',
      period_start: '2026-10-01T00:00:00.000Z' },
  }, schema_version: 1 };
  assert.equal((await setup(storage(), ordered)(bundle('m'))).delivery_status, 'accepted');
  assert.throws(() => setup(storage(), { ...ordered, sinks: {
    ...ordered.sinks, unexpected: ordered.sinks.honeycomb,
  } }), /configuration/);
  assert.throws(() => setup(storage(), { ...ordered, sinks: {
    ...ordered.sinks, honeycomb: { ...ordered.sinks.honeycomb, unexpected: 1 },
  } }), /capacity|exporter/);
});
