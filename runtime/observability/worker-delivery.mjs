import { createHash } from 'node:crypto';
import { validateObservabilityRecord } from './evidence.mjs';
import { mapOtlpRecord } from './otlp.mjs';
import { failedReceipt } from './delivery.mjs';

const PERIOD = ['period_start', 'period_end', 'allowance', 'other_usage'];
const SINKS = ['honeycomb', 'logfire'];
const exactTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const count = value => Number.isSafeInteger(value) && value >= 0;
const decode = value => JSON.parse(value);
const encode = value => JSON.stringify(value);
const one = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray()[0];
const all = (storage, sql, ...args) => storage.sql.exec(sql, ...args).toArray();

function validateConfig(configuration, exporters) {
  if (!configuration || configuration.schema_version !== 1 || !['mirror', 'split'].includes(configuration.mode) ||
      Object.keys(configuration).some(key => !['schema_version', 'mode', 'sinks'].includes(key)) ||
      !configuration.sinks || Object.keys(configuration.sinks).length !== SINKS.length ||
      !SINKS.every(name => Object.hasOwn(configuration.sinks, name)))
    throw new Error('Invalid Worker telemetry configuration');
  for (const name of SINKS) {
    const sink = configuration.sinks[name];
    if (!sink || Object.keys(sink).length !== PERIOD.length ||
        !PERIOD.every(key => Object.hasOwn(sink, key)) ||
        !exactTime(sink.period_start) || !exactTime(sink.period_end) ||
        sink.period_start >= sink.period_end || !count(sink.allowance) ||
        !count(sink.other_usage) || sink.other_usage > sink.allowance || typeof exporters?.[name] !== 'function')
      throw new Error('Invalid Worker telemetry capacity or exporter');
  }
}

/** SQLite-backed Durable Object storage is the coordination atom; all SQL writes commit before network I/O. */
export function createWorkerTelemetryDelivery({ storage, configuration, exporters, now = Date.now,
  maxEntries = 512, retryDelayMs = 60_000 } = {}) {
  validateConfig(configuration, exporters);
  if (!storage?.sql?.exec || typeof storage.transactionSync !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || !count(retryDelayMs))
    throw new Error('Invalid Worker telemetry storage configuration');
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS telemetry_events (
    event_id TEXT PRIMARY KEY, digest TEXT NOT NULL, trace_id TEXT NOT NULL, payload TEXT,
    route TEXT, periods TEXT, receipts TEXT NOT NULL, in_flight TEXT NOT NULL,
    attempts TEXT NOT NULL, next_attempt_at TEXT NOT NULL,
    demand_periods TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS telemetry_budgets (
      sink TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      allowance INTEGER NOT NULL, other_usage INTEGER NOT NULL,
      PRIMARY KEY(sink,period_start,period_end));
    CREATE TABLE IF NOT EXISTS telemetry_reservations (
      event_id TEXT NOT NULL, sink TEXT NOT NULL, period_start TEXT NOT NULL,
      units INTEGER NOT NULL, PRIMARY KEY(event_id,sink,period_start));
    CREATE TABLE IF NOT EXISTS telemetry_blocked_retries (
      event_id TEXT NOT NULL, sink TEXT NOT NULL, period_start TEXT NOT NULL,
      PRIMARY KEY(event_id,sink,period_start));
    CREATE TABLE IF NOT EXISTS telemetry_usage (
      sink TEXT NOT NULL, period_start TEXT NOT NULL,
      observed INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
      attempted INTEGER NOT NULL DEFAULT 0, accepted INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0,
      uncertain INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sink,period_start));`);
  storage.transactionSync(() => {
    for (const name of SINKS) {
      const period = configuration.sinks[name];
      if (one(storage, `SELECT 1 AS overlap FROM telemetry_budgets WHERE sink=?
          AND period_start<? AND period_end>?
          AND (period_start<>? OR period_end<>?) LIMIT 1`,
        name, period.period_end, period.period_start, period.period_start, period.period_end))
        throw new Error('Worker telemetry billing periods overlap existing reservations');
      // A reviewed allocation may increase; already-reserved units and the highest
      // known outside usage remain charged against the refreshed gross allowance.
      storage.sql.exec(`INSERT INTO telemetry_budgets VALUES(?,?,?,?,?)
        ON CONFLICT(sink,period_start,period_end) DO UPDATE SET
        allowance=excluded.allowance,
        other_usage=MAX(telemetry_budgets.other_usage,excluded.other_usage)`,
      name, period.period_start, period.period_end, period.allowance, period.other_usage);
      storage.sql.exec('INSERT OR IGNORE INTO telemetry_usage(sink,period_start) VALUES(?,?)', name, period.period_start);
    }
  });
  const rowFor = id => one(storage, 'SELECT * FROM telemetry_events WHERE event_id=?', id);
  const periodActive = (name, time) => {
    const period = configuration.sinks[name];
    return time >= Date.parse(period.period_start) && time < Date.parse(period.period_end);
  };
  const current = (names = SINKS, time = now()) => Number.isFinite(time) &&
    names.every(name => periodActive(name, time));
  const available = name => {
    const period = configuration.sinks[name];
    const budget = one(storage, `SELECT allowance,other_usage FROM telemetry_budgets
      WHERE sink=? AND period_start=? AND period_end=?`, name, period.period_start, period.period_end);
    const used = one(storage, `SELECT COALESCE(SUM(units),0) AS units FROM telemetry_reservations
      WHERE sink=? AND period_start=?`, name, period.period_start);
    return budget.allowance - budget.other_usage - used.units;
  };
  const remainingUnits = (record, name, previous, mapped = mapOtlpRecord(record)) => {
    const accepted = previous?.accepted_records ?? [];
    const trace = record.trace_id.replaceAll('-', '').toLowerCase();
    return mapped.units[name] - (accepted.includes(`spans:${trace}`) ? mapped.spans.length : 0) -
      (accepted.includes(`logs:${trace}`) ? mapped.logs.length : 0);
  };
  const status = (route, destinations) => {
    const values = Object.values(destinations);
    if (!route || route.split(',').some(name => !destinations[name]) ||
        values.some(item => item.delivery_status === 'capacity_blocked')) return 'capacity_blocked';
    if (values.some(item => item.delivery_status === 'uncertain')) return 'uncertain';
    if (values.some(item => item.delivery_status === 'denied')) return 'denied';
    if (values.some(item => item.delivery_status === 'failed')) return 'failed';
    return values.every(item => item.delivery_status === 'accepted') ? 'accepted' : 'failed';
  };
  const result = row => ({ event_id: row.event_id, trace_id: row.trace_id,
    route: row.route, delivery_status: status(row.route, decode(row.receipts)), destinations: decode(row.receipts) });
  const persist = row => storage.sql.exec(`UPDATE telemetry_events SET payload=?, route=?, periods=?, receipts=?,
    in_flight=?, attempts=?, next_attempt_at=? WHERE event_id=?`, row.payload, row.route, row.periods,
  row.receipts, row.in_flight, row.attempts, row.next_attempt_at, row.event_id);
  const admit = (row, record) => storage.transactionSync(() => {
    row = rowFor(row.event_id);
    if (row.route) return row;
    const units = mapOtlpRecord(record).units;
    const blocked = () => {
      if (!row.blocked) {
        const periods = decode(row.demand_periods);
        for (const name of SINKS) storage.sql.exec(`UPDATE telemetry_usage SET blocked=blocked+?
          WHERE sink=? AND period_start=?`, units[name], name, periods[name]);
        storage.sql.exec('UPDATE telemetry_events SET blocked=1 WHERE event_id=?', row.event_id);
        row.blocked = 1;
      }
      return row;
    };
    const time = now();
    if (!Number.isFinite(time)) return blocked();
    const capacity = Object.fromEntries(SINKS.map(name => [name, periodActive(name, time) ? available(name) : 0]));
    let selected = configuration.mode === 'mirror' ? SINKS : SINKS.filter(name => periodActive(name, time) && capacity[name] >= units[name]);
    if (configuration.mode === 'split' && selected.length > 1)
      selected = [selected.sort((a, b) => (capacity[b] - units[b]) - (capacity[a] - units[a]))[0]];
    if (!selected.length || selected.some(name => !periodActive(name, time) || units[name] > capacity[name])) return blocked();
    row.route = selected.join(',');
    row.periods = encode(Object.fromEntries(selected.map(name => [name, configuration.sinks[name].period_start])));
    for (const name of selected) storage.sql.exec('INSERT INTO telemetry_reservations VALUES(?,?,?,?)',
      row.event_id, name, configuration.sinks[name].period_start, units[name]);
    persist(row);
    return row;
  });
  const snapshot = value => {
    let record;
    try { record = structuredClone(value); validateObservabilityRecord(record); }
    catch { throw new Error('Invalid Worker telemetry trace snapshot'); }
    if (record.record_type !== 'agent.trace') throw new Error('Worker delivery requires a whole trace bundle');
    return record;
  };
  const submit = record => storage.transactionSync(() => {
    const payload = encode(record);
    const digest = createHash('sha256').update(payload).digest('hex');
    const prior = rowFor(record.event_id);
    if (prior) {
      if (prior.digest !== digest) throw new Error('Worker telemetry trace identity collision');
      return prior;
    }
    if (one(storage, 'SELECT COUNT(*) AS count FROM telemetry_events WHERE payload IS NOT NULL').count >= maxEntries)
      throw Object.assign(new Error('Worker telemetry queue capacity exhausted; evidence was not admitted'),
        { code: 'BUFFER_FULL' });
    const units = mapOtlpRecord(record).units;
    const periods = Object.fromEntries(SINKS.map(name => [name, configuration.sinks[name].period_start]));
    storage.sql.exec('INSERT INTO telemetry_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      record.event_id, digest, record.trace_id, payload, null, null, '{}', '{}', '{}', '{}', encode(periods), 0);
    for (const name of SINKS) storage.sql.exec(`UPDATE telemetry_usage SET observed=observed+?
      WHERE sink=? AND period_start=?`, units[name], name, periods[name]);
    return rowFor(record.event_id);
  });
  const active = new Map();
  const checkpointSignal = (row, name, { status, billable_counts: bill, receipt }) => storage.transactionSync(() => {
    row = rowFor(row.event_id);
    if (!decode(row.in_flight)[name]) throw new Error('Telemetry signal claim no longer active');
    const fields = ['attempted_spans', 'attempted_logs', 'accepted_spans', 'accepted_logs',
      'rejected_spans', 'rejected_logs'];
    if (!fields.every(key => count(bill?.[key])) || !['accepted', 'failed', 'uncertain', 'denied'].includes(status) ||
        !receipt || !Array.isArray(receipt.accepted_records))
      throw new Error('Invalid telemetry signal checkpoint');
    const attempted = bill.attempted_spans + bill.attempted_logs;
    const accepted = bill.accepted_spans + bill.accepted_logs;
    const rejected = bill.rejected_spans + bill.rejected_logs;
    if (accepted + rejected > attempted) throw new Error('Invalid telemetry signal counts');
    const receipts = decode(row.receipts);
    const priorKeys = receipts[name]?.accepted_records ?? [];
    if (priorKeys.some(key => !receipt.accepted_records.includes(key)))
      throw new Error('Telemetry signal receipt lost an accepted resource');
    receipts[name] = receipt;
    row.receipts = encode(receipts);
    const remaining = attempted - accepted - rejected;
    storage.sql.exec(`UPDATE telemetry_usage SET attempted=attempted+?, accepted=accepted+?,
      dropped=dropped+?, failed=failed+?, uncertain=uncertain+? WHERE sink=? AND period_start=?`,
    attempted, accepted, rejected, ['failed', 'denied'].includes(status) ? remaining : 0,
    status === 'uncertain' ? remaining : 0, name, decode(row.periods)[name]);
    persist(row);
    return row;
  });
  const recordReceipt = (row, name, receipt, planned, { checkpointed = false, interrupted = false } = {}) => storage.transactionSync(() => {
    row = rowFor(row.event_id);
    const inFlight = decode(row.in_flight);
    if (!inFlight[name]) return row; // A simultaneous caller already settled this claim.
    const receipts = decode(row.receipts);
    const attempts = decode(row.attempts);
    const previous = receipts[name];
    if (previous?.accepted_records?.some(key => !receipt.accepted_records?.includes(key))) {
      receipt = { ...receipt, delivery_status: 'uncertain', reason_code: 'TRANSPORT_UNCERTAIN',
        retryable: false, accepted_records: previous.accepted_records,
        signal_outcomes: previous.signal_outcomes, has_partial_rejection: previous.has_partial_rejection };
    }
    if (receipt.retryable && receipt.reason_code === 'HTTP_429' && attempts[name] >= 3)
      receipt = { ...receipt, retryable: false };
    receipts[name] = receipt;
    delete inFlight[name];
    row.receipts = encode(receipts);
    row.in_flight = encode(inFlight);
    const delay = decode(row.next_attempt_at);
    if (receipt.retryable && receipt.reason_code === 'HTTP_429') delay[name] = now() + retryDelayMs;
    row.next_attempt_at = encode(delay);
    if (!checkpointed || interrupted || receipt.delivery_status === 'uncertain') {
      const bill = receipt.billable_counts;
      const accepted = checkpointed ? 0 : count(bill?.accepted_spans) && count(bill?.accepted_logs) ?
        bill.accepted_spans + bill.accepted_logs : receipt.delivery_status === 'accepted' ? planned : 0;
      const rejected = checkpointed ? 0 : count(bill?.rejected_spans) && count(bill?.rejected_logs) ?
        bill.rejected_spans + bill.rejected_logs : 0;
      const previouslyUncertain = checkpointed ? ['spans', 'logs'].reduce((sum, signal) => {
        if (previous?.signal_outcomes?.[signal]?.status !== 'uncertain') return sum;
        const counts = previous.billable_counts ?? {};
        return sum + Math.max(0, (counts[`attempted_${signal}`] ?? 0) -
          (counts[`accepted_${signal}`] ?? 0) - (counts[`rejected_${signal}`] ?? 0));
      }, 0) : 0;
      const attempted = checkpointed ? (receipt.delivery_status === 'uncertain' && !interrupted ?
        Math.max(0, planned - previouslyUncertain) : 0) :
        count(bill?.attempted_spans) && count(bill?.attempted_logs) ?
          bill.attempted_spans + bill.attempted_logs :
          receipt.delivery_status === 'uncertain' ? planned : accepted + rejected;
      const remaining = Math.max(0, attempted - accepted - rejected);
      const uncertain = receipt.delivery_status === 'uncertain' ?
        Math.max(0, planned - accepted - rejected - previouslyUncertain) : 0;
      const failed = ['failed', 'denied'].includes(receipt.delivery_status) ? remaining : 0;
      storage.sql.exec(`UPDATE telemetry_usage SET attempted=attempted+?, accepted=accepted+?,
        dropped=dropped+?, uncertain=uncertain+?, failed=failed+? WHERE sink=? AND period_start=?`,
      attempted, accepted, rejected, uncertain, failed, name, decode(row.periods)[name]);
    }
    const selected = row.route.split(',');
    if (selected.every(sink => receipts[sink]?.delivery_status === 'accepted') && !Object.keys(inFlight).length)
      row.payload = null; // Only confirmed delivery can discard the canonical payload.
    persist(row);
    return row;
  });
  const claim = (row, record, name) => storage.transactionSync(() => {
    row = rowFor(row.event_id);
    const receipts = decode(row.receipts), inFlight = decode(row.in_flight), attempts = decode(row.attempts);
    if (inFlight[name]) {
      // A crash leaves the external outcome unknowable; no automatic replay.
      const receipt = { delivery_status: 'uncertain', readback_status: 'not_checked',
        reason_code: 'TRANSPORT_UNCERTAIN', reason_provenance: 'unavailable', reason_safe: null,
        failure_stage: 'telemetry_export', retryable: false, accepted_records: receipts[name]?.accepted_records ?? [] };
      return { interrupted: receipt, row };
    }
    if (receipts[name] && !receipts[name].retryable) return { row };
    if (receipts[name] && (receipts[name].reason_code !== 'HTTP_429' ||
        now() < (decode(row.next_attempt_at)[name] ?? Infinity) || (attempts[name] ?? 0) >= 3)) return { row };
    if (!current([name])) return { row, capacityBlocked: true };
    const planned = remainingUnits(record, name, receipts[name]);
    const periods = decode(row.periods);
    const nextPeriod = configuration.sinks[name].period_start;
    // A prior reservation covers same-period 429 retry, but a higher outside
    // baseline can revoke remaining headroom. Rollover needs a fresh reservation.
    if (available(name) < (periods[name] === nextPeriod ? 0 : planned)) {
      const alreadyBlockedOnAdmission = row.blocked && decode(row.demand_periods)[name] === nextPeriod;
      if (!alreadyBlockedOnAdmission && !one(storage,
        'SELECT 1 AS recorded FROM telemetry_blocked_retries WHERE event_id=? AND sink=? AND period_start=?',
        row.event_id, name, nextPeriod)) {
        storage.sql.exec('INSERT INTO telemetry_blocked_retries VALUES(?,?,?)', row.event_id, name, nextPeriod);
        storage.sql.exec(`UPDATE telemetry_usage SET blocked=blocked+? WHERE sink=? AND period_start=?`,
          planned, name, nextPeriod);
      }
      return { row, capacityBlocked: true };
    }
    if (periods[name] !== nextPeriod) {
      storage.sql.exec('INSERT INTO telemetry_reservations VALUES(?,?,?,?)',
        row.event_id, name, nextPeriod, planned);
      periods[name] = nextPeriod;
      row.periods = encode(periods);
    }
    inFlight[name] = true;
    attempts[name] = (attempts[name] ?? 0) + 1;
    row.in_flight = encode(inFlight);
    row.attempts = encode(attempts);
    // Unknown in-flight work is counted uncertain after restart, not as posted.
    persist(row);
    return { row, planned, acceptedRecords: receipts[name]?.accepted_records ?? [] };
  });
  const dispatch = async row => {
    if (row.payload === null) return result(row);
    const record = decode(row.payload);
    row = admit(row, record);
    if (!row.route) return { ...result(row), delivery_status: 'capacity_blocked' };
    let capacityBlocked = false;
    for (const name of row.route.split(',')) {
      const claimed = claim(row, record, name);
      if (claimed.interrupted) {
        const previous = decode(claimed.row.receipts)[name];
        row = recordReceipt(claimed.row, name, claimed.interrupted,
          remainingUnits(record, name, previous), {
            checkpointed: Boolean(previous?.signal_outcomes), interrupted: true,
          });
        continue;
      }
      if (claimed.planned === undefined) {
        capacityBlocked ||= claimed.capacityBlocked === true;
        row = claimed.row;
        continue;
      }
      let receipt, checkpointed = false;
      try {
        receipt = await exporters[name](record, {
          acceptedRecords: claimed.acceptedRecords, previousReceipt: decode(claimed.row.receipts)[name] ?? null,
          onSignal: async progress => {
            row = checkpointSignal(row, name, progress);
            checkpointed = true;
          },
        });
      }
      catch (error) {
        receipt = failedReceipt(error);
        // Unknown errors cannot prove nonacceptance; do not replay them.
        if (receipt.reason_code === 'EXPORT_FAILED' && !(error?.receipt)) receipt = {
          ...receipt, delivery_status: 'uncertain', reason_code: 'TRANSPORT_UNCERTAIN', retryable: false,
        };
      }
      const outstanding = checkpointed ?
        remainingUnits(record, name, decode(rowFor(row.event_id).receipts)[name]) : claimed.planned;
      row = recordReceipt(row, name, receipt, outstanding, { checkpointed });
    }
    return capacityBlocked ? { ...result(row), delivery_status: 'capacity_blocked' } : result(row);
  };
  const canAdmit = record => {
    const time = now();
    if (!Number.isFinite(time)) return false;
    const units = mapOtlpRecord(record).units;
    const fits = name => periodActive(name, time) && available(name) >= units[name];
    return configuration.mode === 'mirror' ? SINKS.every(fits) : SINKS.some(fits);
  };
  const send = async value => {
    const record = snapshot(value);
    if (active.has(record.event_id)) return active.get(record.event_id);
    let row;
    try { row = submit(record); }
    catch (error) {
      if (error.code !== 'BUFFER_FULL') throw error;
      const next = send.nextAttemptAt();
      if (next === null || next > now() + 1) throw error;
      // A due, persisted delivery may release the only buffer slot. Never evict
      // unresolved evidence or replay a signal whose acceptance is uncertain.
      await send.drain({ limit: 100 });
      row = submit(record);
    }
    if (active.has(record.event_id)) return active.get(record.event_id);
    const task = dispatch(row);
    active.set(record.event_id, task);
    return task.finally(() => active.delete(record.event_id));
  };
  send.drain = async ({ limit = 20 } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid Worker drain limit');
    const rows = all(storage, 'SELECT * FROM telemetry_events WHERE payload IS NOT NULL ORDER BY event_id');
    const results = [];
    for (const row of rows) {
      if (results.length >= limit) break;
      if (active.has(row.event_id)) continue;
      const receipts = decode(row.receipts), inFlight = decode(row.in_flight), delays = decode(row.next_attempt_at);
      if ((!row.route && canAdmit(decode(row.payload))) || (row.route &&
          (Object.keys(inFlight).length || row.route.split(',').some(name => !receipts[name] ||
            (receipts[name].retryable && receipts[name].reason_code === 'HTTP_429' &&
              now() >= (delays[name] ?? Infinity))))))
        results.push(await dispatch(row));
    }
    return results;
  };
  send.nextAttemptAt = () => {
    const rows = all(storage, 'SELECT payload,route,periods,receipts,in_flight,next_attempt_at FROM telemetry_events WHERE payload IS NOT NULL');
    const times = [];
    for (const row of rows) if (Object.keys(decode(row.in_flight)).length) times.push(now() + 60_000);
    if (!Number.isFinite(now())) return times.length ? Math.min(...times) : null;
    for (const row of rows) {
      if (!row.route) {
        if (canAdmit(decode(row.payload))) times.push(now() + 1);
        continue;
      }
      const receipts = decode(row.receipts), delays = decode(row.next_attempt_at), periods = decode(row.periods);
      const record = decode(row.payload), mapped = mapOtlpRecord(record);
      for (const name of row.route.split(',')) {
        const previous = receipts[name];
        if (!current([name])) continue;
        if (previous && (!previous.retryable || previous.reason_code !== 'HTTP_429')) continue;
        if (available(name) < (periods[name] === configuration.sinks[name].period_start ?
          0 : remainingUnits(record, name, previous, mapped))) continue;
        if (!previous) times.push(now() + 1);
        else if (count(delays[name])) times.push(delays[name]);
      }
    }
    return times.length ? Math.min(...times) : null;
  };
  send.usage = () => Object.fromEntries(SINKS.map(name => {
    const period = configuration.sinks[name];
    return [name, one(storage, 'SELECT * FROM telemetry_usage WHERE sink=? AND period_start=?', name, period.period_start)];
  }));
  return send;
}
