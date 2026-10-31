import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateObservabilityRecord } from './evidence.mjs';
import { mapOtlpRecord } from './otlp.mjs';
import { createDurableExporter } from './outbox.mjs';
import { failedReceipt } from './delivery.mjs';

const SINKS = ['honeycomb', 'logfire'];
const PERIOD = ['period_start', 'period_end', 'allowance', 'other_usage'];
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const exactTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const hash = record => createHash('sha256').update(JSON.stringify(record)).digest('hex');
const terminal = record => record.event_name === 'agent.turn.finished' || record.event_name === 'agent.turn.completed';
function bufferFull() {
  const error = new Error('Telemetry pending buffer capacity exhausted; existing evidence retained, new record not admitted');
  error.code = 'BUFFER_FULL';
  return error;
}

function validateConfiguration(configuration, exporters, now) {
  if (!configuration || configuration.schema_version !== 1 || !['mirror', 'split'].includes(configuration.mode) ||
      !configuration.sinks || Object.keys(configuration.sinks).sort().join(',') !== SINKS.slice().sort().join(',') ||
      Object.keys(configuration).some(key => !['schema_version', 'mode', 'sinks', 'max_pending_bytes'].includes(key)) ||
      (configuration.max_pending_bytes !== undefined && (!isCount(configuration.max_pending_bytes) || configuration.max_pending_bytes < 1)))
    throw new Error('Invalid telemetry routing configuration');
  for (const name of SINKS) {
    const sink = configuration.sinks[name];
    if (!sink || Object.keys(sink).sort().join(',') !== PERIOD.slice().sort().join(',') ||
        !exactTime(sink.period_start) || !exactTime(sink.period_end) ||
        Date.parse(sink.period_start) >= Date.parse(sink.period_end) ||
        !isCount(sink.allowance) || !isCount(sink.other_usage) ||
        sink.other_usage > sink.allowance || typeof exporters?.[name] !== 'function')
      throw new Error('Invalid telemetry routing capacity or exporter');
  }
  if (typeof now !== 'function') throw new Error('Invalid telemetry routing clock');
}

function openState(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Invalid telemetry state directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()))
    throw new Error('Unsafe telemetry state directory');
  const filename = path.join(directory, 'routing.sqlite');
  let descriptor;
  try {
    descriptor = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    descriptor = openSync(filename, constants.O_RDWR | constants.O_NOFOLLOW);
  }
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.mode & 0o077 || (process.getuid && state.uid !== process.getuid()))
      throw new Error('Unsafe telemetry state file');
  } finally { closeSync(descriptor); }
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  db.exec(`CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT, state TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_trace ON events(trace_id, state);
    CREATE TABLE IF NOT EXISTS traces (trace_id TEXT PRIMARY KEY, route TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bundles (bundle_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, payload TEXT, state TEXT NOT NULL, result TEXT);
    CREATE TABLE IF NOT EXISTS reservations (bundle_id TEXT NOT NULL, sink TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, units INTEGER NOT NULL, PRIMARY KEY(bundle_id,sink,period_start,period_end));
    CREATE TABLE IF NOT EXISTS demand (bundle_id TEXT NOT NULL, sink TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, units INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(bundle_id,sink,period_start,period_end));
    CREATE TABLE IF NOT EXISTS budgets (sink TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, allowance INTEGER NOT NULL, other_usage INTEGER NOT NULL, PRIMARY KEY(sink,period_start,period_end));
    CREATE TABLE IF NOT EXISTS uncertain_markers (bundle_id TEXT NOT NULL, sink TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY(bundle_id,sink,attempt));
    CREATE TABLE IF NOT EXISTS sink_checkpoints (bundle_id TEXT NOT NULL, sink TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(bundle_id,sink));
    CREATE TABLE IF NOT EXISTS sink_attempts (bundle_id TEXT NOT NULL, sink TEXT NOT NULL, attempt INTEGER NOT NULL, PRIMARY KEY(bundle_id,sink,attempt));
    CREATE TABLE IF NOT EXISTS drain_cursor (id INTEGER PRIMARY KEY CHECK(id=1), ready_rowid INTEGER NOT NULL, prefer_outbox INTEGER NOT NULL);
    INSERT OR IGNORE INTO drain_cursor(id,ready_rowid,prefer_outbox) VALUES(1,0,0);
    CREATE TABLE IF NOT EXISTS usage (sink TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sink,period_start,period_end));`);
  return db;
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = action(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Durable trace admission with conservative reservations; never silently sheds or reroutes evidence. */
export function createTelemetryDelivery({ directory, configuration, exporters, now = Date.now }) {
  validateConfiguration(configuration, exporters, now);
  const db = openState(directory);
  const maxBytes = configuration.max_pending_bytes ?? DEFAULT_BUFFER_BYTES;
  const bufferBytes = () => db.prepare(`SELECT
    (SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) FROM events WHERE state<>'done') +
    (SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) FROM bundles WHERE state='ready') AS total`).get().total;
  for (const sink of SINKS) {
    const p = configuration.sinks[sink];
    transaction(db, () => {
      db.prepare('INSERT OR IGNORE INTO usage(sink,period_start,period_end) VALUES(?,?,?)').run(sink, p.period_start, p.period_end);
      db.prepare(`INSERT INTO budgets(sink,period_start,period_end,allowance,other_usage) VALUES(?,?,?,?,?)
        ON CONFLICT(sink,period_start,period_end) DO UPDATE SET allowance=excluded.allowance,
        other_usage=MAX(budgets.other_usage,excluded.other_usage)`).run(sink, p.period_start, p.period_end, p.allowance, p.other_usage);
    });
  }
  let serial = Promise.resolve(), deliveryQueue = Promise.resolve(), admissionFailures = 0;
  const enqueue = fn => { const task = serial.then(fn); serial = task.catch(() => { admissionFailures++; }); return task; };
  const schedule = fn => { const task = deliveryQueue.then(fn); deliveryQueue = task.catch(() => undefined); return task; };
  const period = sink => configuration.sinks[sink];
  const current = () => {
    const ms = now();
    if (!Number.isFinite(ms) || SINKS.some(s => ms < Date.parse(period(s).period_start) || ms >= Date.parse(period(s).period_end)))
      throw new Error('Telemetry billing period unavailable; evidence retained');
  };
  const units = record => mapOtlpRecord(record).units;
  const recordDemand = (record, id) => {
    const needs = units(record);
    for (const sink of SINKS) {
      const p = period(sink);
      db.prepare(`INSERT INTO demand(bundle_id,sink,period_start,period_end,units,state) VALUES(?,?,?,?,?,?)
        ON CONFLICT(bundle_id,sink,period_start,period_end) DO UPDATE SET units=excluded.units
        WHERE demand.state IN ('observed','blocked')`).run(id, sink, p.period_start, p.period_end, needs[sink], 'observed');
    }
    return needs;
  };
  const remaining = sink => {
    const p = period(sink);
    const reservations = db.prepare('SELECT COALESCE(SUM(units),0) AS total FROM reservations WHERE sink=? AND period_start=? AND period_end=?').get(sink, p.period_start, p.period_end).total;
    const baseline = db.prepare('SELECT allowance,other_usage FROM budgets WHERE sink=? AND period_start=? AND period_end=?').get(sink, p.period_start, p.period_end);
    return baseline.allowance - baseline.other_usage - reservations;
  };
  const routeFor = (record, requested) => transaction(db, () => {
    const needs = units(record);
    current();
    const trace = db.prepare('SELECT route FROM traces WHERE trace_id=?').get(record.trace_id);
    const available = Object.fromEntries(SINKS.map(s => [s, remaining(s)]));
    let selected;
    if (trace) selected = trace.route.split(',');
    else if (configuration.mode === 'mirror') selected = SINKS;
    else {
      selected = SINKS.filter(s => available[s] >= needs[s]);
      if (selected.length > 1) selected = [selected.sort((a, b) => (available[b] - needs[b]) - (available[a] - needs[a]))[0]];
    }
    const shortfall = Object.fromEntries(SINKS.map(s => [s, Math.max(0, needs[s] - available[s])]));
    const reserved = Object.fromEntries(SINKS.map(s => [s, db.prepare('SELECT units FROM reservations WHERE bundle_id=? AND sink=? AND period_start=? AND period_end=?').get(requested, s, period(s).period_start, period(s).period_end)?.units ?? 0]));
    if (!selected.length || selected.some(s => needs[s] > available[s] + reserved[s])) {
      const combinedFraction = Math.max(0, 1 - SINKS.reduce((sum, s) => sum + Math.max(0, available[s]) / Math.max(1, needs[s]), 0));
      for (const sink of SINKS)
        db.prepare('UPDATE demand SET state=? WHERE bundle_id=? AND sink=?').run('blocked', requested, sink);
      return { blocked: true, delivery_status: 'capacity_blocked', trace_id: record.trace_id, required: needs, available, shortfall,
        combined_shortfall: { trace_fraction: combinedFraction, honeycomb_units: Math.ceil(combinedFraction * needs.honeycomb),
          logfire_units: Math.ceil(combinedFraction * needs.logfire) }, route: trace?.route ?? null };
    }
    for (const sink of SINKS)
      db.prepare('UPDATE demand SET state=? WHERE bundle_id=? AND sink=?').run('routed', requested, sink);
    if (!trace) db.prepare('INSERT INTO traces(trace_id,route) VALUES(?,?)').run(record.trace_id, selected.join(','));
    for (const sink of selected) {
      const p = period(sink);
      db.prepare('INSERT OR IGNORE INTO reservations(bundle_id,sink,period_start,period_end,units) VALUES(?,?,?,?,?)').run(requested, sink, p.period_start, p.period_end, needs[sink]);
    }
    return { blocked: false, route: selected.join(','), selected, required: needs };
  });
  const receiptFor = (record, results) => ({
    event_id: record.event_id,
    trace_id: record.trace_id,
    observed_at: record.records?.findLast(item => item.event_name === 'agent.turn.finished' || item.event_name === 'agent.turn.completed')?.observed_at ??
      record.records?.findLast(item => item.event_name === 'agent.turn.completed')?.ended_at ??
      record.observed_at ?? record.ended_at ?? new Date(now()).toISOString(),
    recorded_at: new Date(now()).toISOString(),
    route: Object.keys(results).join(','),
    delivery_status: Object.values(results).every(r => r.delivery_status === 'accepted') ? 'accepted' :
      Object.values(results).some(r => r.delivery_status === 'uncertain') ? 'uncertain' :
      Object.values(results).some(r => r.delivery_status === 'capacity_blocked') ? 'capacity_blocked' : 'failed',
    destinations: results,
  });
  const count = (sink, receipt, planned) => {
    const p = period(sink);
    const accepted = receipt.billable_counts?.accepted_spans + receipt.billable_counts?.accepted_logs;
    const rejected = receipt.billable_counts?.rejected_spans + receipt.billable_counts?.rejected_logs;
    const ack = Number.isSafeInteger(accepted) ? accepted : receipt.delivery_status === 'accepted' ? planned : 0;
    const drop = Number.isSafeInteger(rejected) ? rejected : 0;
    const fail = receipt.delivery_status === 'failed' || receipt.delivery_status === 'denied' ? Math.max(0, planned - ack - drop) : 0;
    const uncertain = receipt.delivery_status === 'uncertain' ? Math.max(0, planned - ack - drop) : 0;
    transaction(db, () => db.prepare('UPDATE usage SET accepted=accepted+?, failed=failed+?, dropped=dropped+?, uncertain=uncertain+? WHERE sink=? AND period_start=? AND period_end=?').run(ack, fail, drop, uncertain, sink, p.period_start, p.period_end));
  };
  const exporter = async (record, { receipts = {}, attempt = 0 } = {}) => {
    const route = db.prepare('SELECT route FROM traces WHERE trace_id=?').get(record.trace_id);
    if (!route) throw new Error('Missing telemetry route assignment');
    const results = {}, mapped = mapOtlpRecord(record);
    for (const sink of route.route.split(',')) {
      const priorFinal = receipts?.[sink];
      const checkpoint = db.prepare('SELECT receipt FROM sink_checkpoints WHERE bundle_id=? AND sink=?').get(record.event_id, sink);
      const prior = checkpoint ? JSON.parse(checkpoint.receipt) : priorFinal;
      if (prior && !prior.retryable && prior.delivery_status !== 'pending') { results[sink] = prior; continue; }
      const p = period(sink), ms = now();
      const acceptedKeys = prior?.accepted_records ?? [];
      const outstanding = mapped.units[sink] -
        (acceptedKeys.some(key => key.startsWith('spans:')) ? mapped.spans.length : 0) -
        (acceptedKeys.some(key => key.startsWith('logs:')) ? mapped.logs.length : 0);
      const active = Number.isFinite(ms) && ms >= Date.parse(p.period_start) && ms < Date.parse(p.period_end);
      const admitted = active && transaction(db, () => {
        const reserved = db.prepare('SELECT units FROM reservations WHERE bundle_id=? AND sink=? AND period_start=? AND period_end=?')
          .get(record.event_id, sink, p.period_start, p.period_end);
        if (!reserved && remaining(sink) < outstanding) return false;
        if (!reserved) db.prepare('INSERT INTO reservations(bundle_id,sink,period_start,period_end,units) VALUES(?,?,?,?,?)')
          .run(record.event_id, sink, p.period_start, p.period_end, outstanding);
        return true;
      });
      if (!admitted) {
        results[sink] = { delivery_status: 'capacity_blocked', readback_status: 'not_checked',
          reason_code: 'CAPACITY_BLOCKED', reason_provenance: 'unavailable', reason_safe: null,
          failure_stage: 'telemetry_export', retryable: true, accepted_records: acceptedKeys,
          shortfall: { [sink]: active ? Math.max(0, outstanding - remaining(sink)) : outstanding } };
        continue;
      }
      let signalled = false, checkpointFailure = null;
      const onSignal = async ({ status, billable_counts: delta, receipt: progress }) => {
        const attempted = (delta.attempted_spans ?? 0) + (delta.attempted_logs ?? 0);
        const accepted = (delta.accepted_spans ?? 0) + (delta.accepted_logs ?? 0);
        const rejected = (delta.rejected_spans ?? 0) + (delta.rejected_logs ?? 0);
        try {
          transaction(db, () => {
            db.prepare(`UPDATE usage SET attempted=attempted+?,accepted=accepted+?,dropped=dropped+?,
              failed=failed+?,uncertain=uncertain+? WHERE sink=? AND period_start=? AND period_end=?`)
              .run(attempted, accepted, rejected,
                ['failed', 'denied'].includes(status) ? Math.max(0, attempted - accepted - rejected) : 0,
                status === 'uncertain' ? Math.max(0, attempted - accepted - rejected) : 0,
                sink, p.period_start, p.period_end);
            db.prepare(`INSERT INTO sink_checkpoints(bundle_id,sink,receipt) VALUES(?,?,?)
              ON CONFLICT(bundle_id,sink) DO UPDATE SET receipt=excluded.receipt`)
              .run(record.event_id, sink, JSON.stringify(progress));
          });
        } catch (error) {
          checkpointFailure = error;
          throw error;
        }
        signalled = true;
      };
      db.prepare('INSERT OR IGNORE INTO sink_attempts(bundle_id,sink,attempt) VALUES(?,?,?)')
        .run(record.event_id, sink, attempt);
      let receipt;
      try {
        receipt = await exporters[sink](record, { acceptedRecords: acceptedKeys, previousReceipt: prior, onSignal });
      } catch (error) {
        if (checkpointFailure) throw checkpointFailure;
        receipt = failedReceipt(error);
        if (!error?.receipt) receipt = { ...receipt, delivery_status: 'uncertain', reason_code: 'TRANSPORT_UNCERTAIN' };
      }
      if (!signalled && receipt.billable_counts?.attempted_spans === undefined) {
        transaction(db, () => db.prepare('UPDATE usage SET attempted=attempted+? WHERE sink=? AND period_start=? AND period_end=?')
          .run(outstanding, sink, p.period_start, p.period_end));
        count(sink, receipt, outstanding);
      }
      db.prepare(`INSERT INTO sink_checkpoints(bundle_id,sink,receipt) VALUES(?,?,?)
        ON CONFLICT(bundle_id,sink) DO UPDATE SET receipt=excluded.receipt`).run(record.event_id, sink, JSON.stringify(receipt));
      results[sink] = receipt;
    }
    const aggregate = receiptFor(record, results);
    db.prepare('UPDATE bundles SET result=? WHERE bundle_id=? AND state=?').run(JSON.stringify(aggregate), record.event_id, 'done');
    return aggregate;
  };
  const onInterrupted = async (record, { receipts, attempts }) => {
    const route = db.prepare('SELECT route FROM traces WHERE trace_id=?').get(record.trace_id);
    if (!route) return;
    const mapped = mapOtlpRecord(record);
    transaction(db, () => {
      for (const sink of route.route.split(',')) {
        const started = db.prepare('SELECT 1 FROM sink_attempts WHERE bundle_id=? AND sink=? AND attempt=?')
          .get(record.event_id, sink, attempts);
        if (!started) continue;
        const checkpoint = db.prepare('SELECT receipt FROM sink_checkpoints WHERE bundle_id=? AND sink=?').get(record.event_id, sink);
        const previous = checkpoint ? JSON.parse(checkpoint.receipt) : receipts?.[sink];
        if (previous && !previous.retryable && previous.delivery_status !== 'pending') continue;
        const priorKeys = previous?.accepted_records ?? [];
        const remainingUnits = mapped.units[sink] -
          (priorKeys.some(key => key.startsWith('spans:')) ? mapped.spans.length : 0) -
          (priorKeys.some(key => key.startsWith('logs:')) ? mapped.logs.length : 0);
        const marker = db.prepare('INSERT OR IGNORE INTO uncertain_markers(bundle_id,sink,attempt) VALUES(?,?,?)').run(record.event_id, sink, attempts);
        if (!marker.changes) continue;
        const reserved = db.prepare('SELECT period_start FROM reservations WHERE bundle_id=? AND sink=? ORDER BY period_start DESC LIMIT 1').get(record.event_id, sink);
        if (reserved) db.prepare('UPDATE usage SET uncertain=uncertain+? WHERE sink=? AND period_start=?').run(remainingUnits, sink, reserved.period_start);
      }
    });
  };
  const beforeAttempt = async (record, { receipts }) => {
    const assigned = db.prepare('SELECT route FROM traces WHERE trace_id=?').get(record.trace_id);
    if (!assigned) throw new Error('Missing telemetry route assignment');
    const mapped = mapOtlpRecord(record), selected = assigned.route.split(',');
    const outstanding = Object.fromEntries(selected.filter(sink => !receipts?.[sink] || receipts[sink].retryable).map(sink => {
      const accepted = receipts?.[sink]?.accepted_records ?? [];
      return [sink, mapped.units[sink] -
        (accepted.some(key => key.startsWith('spans:')) ? mapped.spans.length : 0) -
        (accepted.some(key => key.startsWith('logs:')) ? mapped.logs.length : 0)];
    }));
    return transaction(db, () => {
      const shortfall = {};
      const ms = now();
      for (const [sink, needed] of Object.entries(outstanding)) {
        const p = period(sink);
        const within = Number.isFinite(ms) && ms >= Date.parse(p.period_start) && ms < Date.parse(p.period_end);
        const own = db.prepare('SELECT units FROM reservations WHERE bundle_id=? AND sink=? AND period_start=? AND period_end=?')
          .get(record.event_id, sink, p.period_start, p.period_end)?.units ?? 0;
        shortfall[sink] = within ? Math.max(0, needed - remaining(sink) - own) : needed;
      }
      if (Object.values(shortfall).some(value => value > 0) || !Number.isFinite(ms) ||
          selected.some(sink => ms < Date.parse(period(sink).period_start) || ms >= Date.parse(period(sink).period_end))) {
        db.prepare('UPDATE demand SET state=? WHERE bundle_id=?').run('blocked', record.event_id);
        return { delivery_status: 'capacity_blocked', reason_code: 'CAPACITY_BLOCKED', route: assigned.route, shortfall };
      }
      for (const [sink, needed] of Object.entries(outstanding)) {
        const p = period(sink);
        db.prepare('INSERT OR IGNORE INTO reservations(bundle_id,sink,period_start,period_end,units) VALUES(?,?,?,?,?)')
          .run(record.event_id, sink, p.period_start, p.period_end, needed);
      }
      db.prepare('UPDATE demand SET state=? WHERE bundle_id=?').run('routed', record.event_id);
      return null;
    });
  };
  const outbox = createDurableExporter({ directory: path.join(directory, 'outbox'), exporter, now, onInterrupted, beforeAttempt });
  const emit = async (bundle, id) => {
    const decision = routeFor(bundle, id);
    if (decision.blocked) return decision;
    const receipt = await outbox(bundle);
    transaction(db, () => {
      db.prepare('UPDATE bundles SET state=?,payload=NULL,result=? WHERE bundle_id=?').run('done', JSON.stringify(receipt), id);
      const finish = db.prepare('UPDATE events SET state=?,payload=NULL WHERE event_id=? AND state=?');
      if (bundle.record_type === 'agent.trace') {
        for (const member of bundle.records) finish.run('done', member.event_id, 'ready');
      } else finish.run('done', bundle.event_id, 'ready');
    });
    return { ...receipt, delivery_status: receipt.delivery_status ?? 'accepted', route: decision.route };
  };
  const dispatchReady = async id => {
    const row = db.prepare('SELECT payload,state,result FROM bundles WHERE bundle_id=?').get(id);
    if (!row) throw new Error('Missing durable telemetry bundle');
    if (row.state !== 'done') return emit(JSON.parse(row.payload), id);
    const original = JSON.parse(row.result);
    const receipt = await outbox.retry(id);
    if (!receipt) return original;
    const updated = { ...receipt, route: original.route };
    db.prepare('UPDATE bundles SET result=? WHERE bundle_id=?').run(JSON.stringify(updated), id);
    return updated;
  };
  const submit = value => {
    let record;
    try { record = structuredClone(value); validateObservabilityRecord(record); }
    catch { throw new Error('Invalid telemetry event snapshot'); }
    if (record.record_type === 'agent.trace') {
      // Externally prepared complete bundles are admitted as one logical outbox event.
      const existing = db.prepare('SELECT payload,state,result FROM bundles WHERE bundle_id=?').get(record.event_id);
      if (existing?.state === 'done') return { dispatch: () => dispatchReady(record.event_id) };
      if (existing && existing.payload !== JSON.stringify(record)) throw new Error('Telemetry bundle identity collision');
      if (!existing) transaction(db, () => {
        const serialized = JSON.stringify(record);
        if (bufferBytes() + Buffer.byteLength(serialized) > maxBytes) throw bufferFull();
        db.prepare('INSERT INTO bundles(bundle_id,trace_id,payload,state) VALUES(?,?,?,?)').run(record.event_id, record.trace_id, serialized, 'ready');
        recordDemand(record, record.event_id);
      });
      return { dispatch: () => dispatchReady(record.event_id) };
    }
    const traceId = record.trace_id ?? record.event_id;
    const payload = JSON.stringify(record), digest = hash(record), existing = db.prepare('SELECT digest,state FROM events WHERE event_id=?').get(record.event_id);
    if (existing) {
      if (existing.digest !== digest) throw new Error('Telemetry event identity collision');
      if (existing.state === 'done') {
        const bundle = db.prepare('SELECT bundle_id FROM bundles WHERE bundle_id=?').get(record.event_id) ??
          db.prepare('SELECT bundle_id FROM bundles WHERE bundle_id=?').get(traceId);
        return bundle ? { dispatch: () => dispatchReady(bundle.bundle_id) } :
          { event_id: record.event_id, trace_id: traceId, delivery_status: 'recorded', route: db.prepare('SELECT route FROM traces WHERE trace_id=?').get(traceId)?.route ?? null };
      }
      if (existing.state === 'ready') {
        const bundle = db.prepare('SELECT * FROM bundles WHERE trace_id=? AND state=?').get(traceId, 'ready');
        if (bundle) return { dispatch: () => dispatchReady(bundle.bundle_id) };
      }
    }
    if (terminal(record) && db.prepare('SELECT bundle_id FROM bundles WHERE bundle_id=?').get(traceId))
      throw new Error('Telemetry trace terminal identity collision');
    const waiting = !existing && db.prepare('SELECT bundle_id FROM bundles WHERE trace_id=? AND state=?').get(traceId, 'ready');
    if (waiting) {
      const appended = transaction(db, () => {
        if (db.prepare('SELECT route FROM traces WHERE trace_id=?').get(traceId)) return null;
        const current = db.prepare('SELECT bundle_id,payload FROM bundles WHERE bundle_id=? AND state=?').get(waiting.bundle_id, 'ready');
        if (!current) return null;
        const bundle = JSON.parse(current.payload);
        bundle.records.push(record);
        validateObservabilityRecord(bundle);
        const serialized = JSON.stringify(bundle);
        const added = Buffer.byteLength(payload) + Buffer.byteLength(serialized) - Buffer.byteLength(current.payload);
        if (bufferBytes() + added > maxBytes) throw bufferFull();
        db.prepare('INSERT INTO events(event_id,trace_id,digest,payload,state) VALUES(?,?,?,?,?)').run(record.event_id, traceId, digest, payload, 'ready');
        db.prepare('UPDATE bundles SET payload=? WHERE bundle_id=?').run(serialized, current.bundle_id);
        recordDemand(bundle, current.bundle_id);
        return current.bundle_id;
      });
      if (appended) return { dispatch: () => dispatchReady(appended) };
    }
    const existingRoute = db.prepare('SELECT route FROM traces WHERE trace_id=?').get(traceId);
    if (existingRoute && !terminal(record)) {
      if (!existing || existing.state === 'pending') transaction(db, () => {
        if (bufferBytes() + (existing ? 1 : 2) * Buffer.byteLength(payload) > maxBytes) throw bufferFull();
        if (!existing) db.prepare('INSERT INTO events(event_id,trace_id,digest,payload,state) VALUES(?,?,?,?,?)')
          .run(record.event_id, traceId, digest, payload, 'ready');
        else db.prepare('UPDATE events SET state=? WHERE event_id=? AND state=?').run('ready', record.event_id, 'pending');
        db.prepare('INSERT INTO bundles(bundle_id,trace_id,payload,state) VALUES(?,?,?,?)').run(record.event_id, traceId, payload, 'ready');
        recordDemand(record, record.event_id);
      });
      return { dispatch: () => dispatchReady(record.event_id) };
    }
    const terminalRecord = terminal(record);
    if (!terminalRecord) {
      if (!existing) transaction(db, () => {
        if (bufferBytes() + Buffer.byteLength(payload) > maxBytes) throw bufferFull();
        db.prepare('INSERT INTO events(event_id,trace_id,digest,payload,state) VALUES(?,?,?,?,?)').run(record.event_id, traceId, digest, payload, 'pending');
      });
      return { event_id: record.event_id, trace_id: traceId, delivery_status: 'pending' };
    }
    const bundleId = traceId;
    let row = db.prepare('SELECT * FROM bundles WHERE bundle_id=?').get(bundleId);
    if (!row) {
      row = transaction(db, () => {
        if (!existing) {
          if (bufferBytes() + Buffer.byteLength(payload) > maxBytes) throw bufferFull();
          db.prepare('INSERT INTO events(event_id,trace_id,digest,payload,state) VALUES(?,?,?,?,?)').run(record.event_id, traceId, digest, payload, 'pending');
        }
        const members = db.prepare('SELECT event_id,payload FROM events WHERE trace_id=? AND state=? ORDER BY rowid').all(traceId, 'pending');
        const bundle = { schema_version: 1, record_type: 'agent.trace', event_id: bundleId, trace_id: traceId,
          records: members.map(member => JSON.parse(member.payload)) };
        validateObservabilityRecord(bundle);
        const serialized = JSON.stringify(bundle);
        if (bufferBytes() + Buffer.byteLength(serialized) > maxBytes) throw bufferFull();
        db.prepare('INSERT INTO bundles(bundle_id,trace_id,payload,state) VALUES(?,?,?,?)').run(bundleId, traceId, serialized, 'ready');
        const promote = db.prepare('UPDATE events SET state=? WHERE event_id=? AND state=?');
        for (const member of members) promote.run('ready', member.event_id, 'pending');
        recordDemand(bundle, bundleId);
        return { bundle_id: bundleId };
      });
    }
    return { dispatch: () => dispatchReady(row.bundle_id) };
  };
  const send = record => enqueue(() => submit(record)).then(result => result?.dispatch ? schedule(result.dispatch) : result);
  send.admit = record => enqueue(() => {
    submit(record);
    return send.getAdmission(record.event_id);
  });
  send.drain = ({ limit = 20 } = {}) => serial.then(() => schedule(async () => {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid telemetry drain limit');
    const outcomes = [];
    const recover = db.prepare(`SELECT e.payload FROM events e WHERE e.state='pending'
      AND (json_extract(e.payload,'$.event_name') IN ('agent.turn.finished','agent.turn.completed')
        OR EXISTS (SELECT 1 FROM traces t WHERE t.trace_id=e.trace_id))
      ORDER BY e.rowid LIMIT ?`);
    for (const row of recover.all(limit)) {
      const candidate = submit(JSON.parse(row.payload));
      if (candidate.dispatch) outcomes.push(await candidate.dispatch());
      if (outcomes.length >= limit) return outcomes;
    }
    const cursor = db.prepare('SELECT ready_rowid,prefer_outbox FROM drain_cursor WHERE id=1').get();
    db.prepare('UPDATE drain_cursor SET prefer_outbox=? WHERE id=1').run(cursor.prefer_outbox ? 0 : 1);
    if (cursor.prefer_outbox && outcomes.length < limit)
      outcomes.push(...await outbox.drain({ limit: 1 }));
    if (outcomes.length < limit) {
      const available = limit - outcomes.length;
      const later = db.prepare('SELECT rowid AS position,* FROM bundles WHERE state=? AND rowid>? ORDER BY rowid LIMIT ?')
        .all('ready', cursor.ready_rowid, available);
      const earlier = later.length < available ?
        db.prepare('SELECT rowid AS position,* FROM bundles WHERE state=? AND rowid<=? ORDER BY rowid LIMIT ?')
          .all('ready', cursor.ready_rowid, available - later.length) : [];
      for (const row of [...later, ...earlier]) {
        db.prepare('UPDATE drain_cursor SET ready_rowid=? WHERE id=1').run(row.position);
        outcomes.push(await emit(JSON.parse(row.payload), row.bundle_id));
        if (outcomes.length >= limit) return outcomes;
      }
    }
    if (!cursor.prefer_outbox && outcomes.length < limit)
      outcomes.push(...await outbox.drain({ limit: limit - outcomes.length }));
    return outcomes;
  }));
  send.flushPersistence = () => serial.then(() => {
    if (admissionFailures) {
      const count = admissionFailures;
      admissionFailures = 0;
      throw new Error(`Telemetry admission failed for ${count} record(s); evidence may be incomplete`);
    }
  });
  send.getAdmission = eventId => {
    if (typeof eventId !== 'string' || !UUID.test(eventId)) throw new Error('Invalid telemetry admission ID');
    const bundle = db.prepare('SELECT trace_id,state FROM bundles WHERE bundle_id=?').get(eventId);
    if (bundle) return { persisted: true, state: bundle.state, trace_id: bundle.trace_id };
    const event = db.prepare('SELECT trace_id,state FROM events WHERE event_id=?').get(eventId);
    return event ? { persisted: true, state: event.state, trace_id: event.trace_id } : { persisted: false };
  };
  send.getUsage = () => Object.fromEntries(SINKS.map(sink => {
    const p = period(sink);
    const counts = db.prepare('SELECT attempted,accepted,failed,dropped,uncertain FROM usage WHERE sink=? AND period_start=? AND period_end=?').get(sink, p.period_start, p.period_end);
    const reserved = db.prepare('SELECT COALESCE(SUM(units),0) AS total FROM reservations WHERE sink=? AND period_start=? AND period_end=?').get(sink, p.period_start, p.period_end).total;
    const baseline = db.prepare('SELECT allowance,other_usage FROM budgets WHERE sink=? AND period_start=? AND period_end=?').get(sink, p.period_start, p.period_end);
    const demand = db.prepare(`SELECT COALESCE(SUM(units),0) AS observed,
      COALESCE(SUM(CASE WHEN state='blocked' THEN units ELSE 0 END),0) AS blocked
      FROM demand WHERE sink=? AND period_start=? AND period_end=?`).get(sink, p.period_start, p.period_end);
    return [sink, { ...counts, ...demand, period_start: p.period_start, period_end: p.period_end, allowance: baseline.allowance, other_usage: baseline.other_usage, reserved, available: baseline.allowance - baseline.other_usage - reserved }];
  }));
  return send;
}

/** Read-only monthly accounting for host reporting; no exporter or credential required. */
export function readTelemetryUsage({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Invalid telemetry state directory');
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.mode & 0o077 || (process.getuid && parent.uid !== process.getuid()))
    throw new Error('Unsafe telemetry state directory');
  const filename = path.join(directory, 'routing.sqlite');
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = fstatSync(descriptor);
    if (!state.isFile() || state.mode & 0o077 || (process.getuid && state.uid !== process.getuid()))
      throw new Error('Unsafe telemetry state file');
  } finally { closeSync(descriptor); }
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const sinks = Object.fromEntries(SINKS.map(sink => [sink, db.prepare(`SELECT u.period_start,u.period_end,u.attempted,u.accepted,u.failed,u.dropped,u.uncertain,
      b.allowance,b.other_usage,
      COALESCE((SELECT SUM(r.units) FROM reservations r WHERE r.sink=u.sink AND r.period_start=u.period_start AND r.period_end=u.period_end),0) AS reserved,
      COALESCE((SELECT SUM(d.units) FROM demand d WHERE d.sink=u.sink AND d.period_start=u.period_start AND d.period_end=u.period_end),0) AS observed,
      COALESCE((SELECT SUM(d.units) FROM demand d WHERE d.sink=u.sink AND d.period_start=u.period_start AND d.period_end=u.period_end AND d.state='blocked'),0) AS blocked
      FROM usage u JOIN budgets b ON b.sink=u.sink AND b.period_start=u.period_start AND b.period_end=u.period_end
      WHERE u.sink=? ORDER BY u.period_start DESC`).all(sink).map(row => ({
        ...row, available: row.allowance - row.other_usage - row.reserved,
      }))]));
    return {
      sinks,
      pending_traces: db.prepare('SELECT COUNT(DISTINCT trace_id) AS total FROM events WHERE state=?').get('pending').total,
      blocked_traces: db.prepare('SELECT COUNT(*) AS total FROM bundles b WHERE b.state=? AND NOT EXISTS (SELECT 1 FROM traces t WHERE t.trace_id=b.trace_id)').get('ready').total,
    };
  } finally { db.close(); }
}
