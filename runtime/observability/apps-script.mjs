// Portable Apps Script telemetry source. The private checkout installs this file verbatim
// after removing the ESM export; GAS platform services are injected for VM parity.
const APP_TELEMETRY_HOSTS = {
  honeycomb: ["https://api.honeycomb.io", "https://api.eu1.honeycomb.io"],
  logfire: ["https://logfire-us.pydantic.dev", "https://logfire-eu.pydantic.dev"]
};
const APP_TELEMETRY_PREFIX = "AGENT_TELEMETRY_";

export function createAppsScriptObservability(platform) {
  const { Utilities, PropertiesService, LockService, UrlFetchApp } = platform;
  const properties = PropertiesService.getScriptProperties();
  const clock = platform.now || (() => Date.now());
  const hash = (value) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value))
    .map((byte) => (byte & 255).toString(16).padStart(2, "0")).join("");
  const sensitive = /(?:bearer\s+\S+|(?:sk|ghp|gho|github_pat|xox[baprs])[-_][a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|eyJ[a-z0-9_-]{8,}\.eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i;
  const text = (value) => typeof value === "string" && /^[A-Za-z0-9_.:/-]{1,128}$/.test(value) &&
    !sensitive.test(value) ? value : null;
  const timestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 18446744073709;
  const nanos = (value) => String(value) + "000000";
  const attr = (values) => Object.keys(values).filter((key) => values[key] !== null && values[key] !== undefined)
    .map((key) => {
      const value = values[key];
      return { key, value: typeof value === "boolean" ? { boolValue: value } :
        typeof value === "number" ? { intValue: String(value) } : { stringValue: String(value) } };
    });
  function uuid(source, observed) {
    const digest = hash(source);
    const time = observed.toString(16).padStart(12, "0").slice(-12);
    return `${time.slice(0, 8)}-${time.slice(8)}-7${digest.slice(0, 3)}-8${digest.slice(3, 6)}-${digest.slice(6, 18)}`;
  }
  const spanId = (id, label = "") => hash(`agent-platform:otlp:span:${id.toLowerCase()}:${label}`).slice(0, 16);
  function settings() {
    const mode = properties.getProperty("AGENT_TELEMETRY_MODE") || "legacy";
    if (!["legacy", "mirror", "split"].includes(mode)) throw new Error("Invalid telemetry configuration: mode");
    if (mode === "legacy") return { mode };
    const destinations = [
      { name: "honeycomb", endpoint: properties.getProperty("HONEYCOMB_OTLP_ENDPOINT"),
        credential: properties.getProperty("HONEYCOMB_API_KEY"), allowance: properties.getProperty("HONEYCOMB_ALLOWANCE"),
        otherUsage: properties.getProperty("HONEYCOMB_OTHER_USAGE"),
        periodStart: properties.getProperty("HONEYCOMB_PERIOD_START"), periodEnd: properties.getProperty("HONEYCOMB_PERIOD_END") },
      { name: "logfire", endpoint: properties.getProperty("LOGFIRE_OTLP_ENDPOINT"),
        credential: properties.getProperty("LOGFIRE_WRITE_TOKEN"), allowance: properties.getProperty("LOGFIRE_ALLOWANCE"),
        otherUsage: properties.getProperty("LOGFIRE_OTHER_USAGE"),
        periodStart: properties.getProperty("LOGFIRE_PERIOD_START"), periodEnd: properties.getProperty("LOGFIRE_PERIOD_END") }
    ];
    const count = (value) => /^(0|[1-9]\d*)$/.test(value || "") && Number.isSafeInteger(Number(value));
    const period = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value;
    for (const dest of destinations) {
      if (!APP_TELEMETRY_HOSTS[dest.name].includes(dest.endpoint) ||
          typeof dest.credential !== "string" || !dest.credential.trim() ||
          !count(dest.allowance) || !count(dest.otherUsage) ||
          !period(dest.periodStart) || !period(dest.periodEnd) ||
          Date.parse(dest.periodStart) >= Date.parse(dest.periodEnd))
        throw new Error("Invalid telemetry configuration: " + dest.name);
      dest.limit = Number(dest.allowance) - Number(dest.otherUsage);
      dest.period = { start: dest.periodStart, end: dest.periodEnd };
      dest.active = clock() >= Date.parse(dest.periodStart) && clock() < Date.parse(dest.periodEnd);
      dest.otherUsage = Number(dest.otherUsage);
    }
    return { mode, destinations };
  }
  function mapGeneration(options, observed, traceId) {
    const traceHex = traceId.replace(/-/g, "");
    const rootId = spanId(traceId);
    const base = {
      "gen_ai.operation.name": "chat", "gen_ai.agent.name": "apps-script",
      "gen_ai.conversation.id": options.sessionId == null ? null : hash(options.sessionId),
      "gen_ai.provider.name": text(options.provider), "gen_ai.request.model": text(options.model),
      "agent.runtime": "google-apps-script", "agent.outcome": options.error || (options.statusCode >= 400) ? "failed" : "succeeded",
      "agent.timing.known": false
    };
    for (const [source, key] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"]]) {
      if (Number.isSafeInteger(options[source]) && options[source] >= 0)
        base["gen_ai.usage." + key] = options[source];
    }
    if (Number.isSafeInteger(options.totalTokens) && options.totalTokens >= 0)
      base["gen_ai.usage.total_tokens"] = options.totalTokens;
    if (Number.isSafeInteger(options.statusCode) && options.statusCode >= 100 && options.statusCode <= 599)
      base["http.response.status_code"] = options.statusCode;
    const spans = [], logs = [];
    const known = timestamp(options.startedMs) && timestamp(options.endedMs) && options.endedMs >= options.startedMs;
    if (known) {
      base["agent.timing.known"] = true;
      spans.push({ traceId: traceHex, spanId: rootId, name: "apps-script.ai-generation", kind: 1,
        startTimeUnixNano: nanos(options.startedMs), endTimeUnixNano: nanos(options.endedMs),
        attributes: attr(base), status: { code: base["agent.outcome"] === "failed" ? 2 : 1 } });
    } else {
      logs.push({ traceId: traceHex, timeUnixNano: nanos(observed),
        body: { stringValue: "AI generation observed with unknown timing" },
        attributes: attr(base), severityNumber: base["agent.outcome"] === "failed" ? 17 : 9 });
    }
    // Child spans exist only for explicitly instrumented operations, never guessed model calls.
    for (const operation of options.operations || []) {
      if (!operation || !text(operation.id) || !text(operation.name)) throw new Error("Invalid observed operation");
      const childId = spanId(traceId, operation.id);
      const fields = attr({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": operation.name,
        "agent.timing.known": timestamp(operation.startedMs) && timestamp(operation.endedMs) && operation.endedMs >= operation.startedMs });
      if (known && timestamp(operation.startedMs) && timestamp(operation.endedMs) && operation.endedMs >= operation.startedMs) {
        spans.push({ traceId: traceHex, spanId: childId, parentSpanId: rootId, name: operation.name,
          kind: 1, startTimeUnixNano: nanos(operation.startedMs), endTimeUnixNano: nanos(operation.endedMs),
          attributes: fields, status: { code: operation.failed === true ? 2 : 1 } });
      } else logs.push({ traceId: traceHex, ...(known ? { spanId: rootId } : {}), timeUnixNano: nanos(observed),
        body: { stringValue: "Observed operation with unknown timing" }, attributes: fields,
        severityNumber: operation.failed === true ? 17 : 9 });
    }
    return { spans, logs, units: spans.length + logs.length };
  }
  // Small fixed OTLP/proto3 encoder. GAS byte arrays and blobs replace Node Buffer.
  function bytes(value) { return Utilities.newBlob(String(value)).getBytes().map((byte) => byte & 255); }
  function varint(value) {
    const result = [];
    do { const part = value % 128; value = Math.floor(value / 128); result.push(part | (value ? 128 : 0)); } while (value);
    return result;
  }
  function fixed64(decimal) {
    let digits = String(decimal).split("").map(Number);
    const output = [];
    for (let i = 0; i < 8; i++) {
      let remainder = 0, quotient = [];
      for (const digit of digits) {
        const value = remainder * 10 + digit;
        if (quotient.length || value >= 256) quotient.push(Math.floor(value / 256));
        remainder = value % 256;
      }
      output.push(remainder); digits = quotient;
    }
    if (digits.length) throw new Error("Invalid telemetry timestamp");
    return output;
  }
  const hex = (value) => (value.match(/../g) || []).map((pair) => parseInt(pair, 16));
  function wire(field, input, kind) {
    if (kind === "int") return [...varint(field * 8), ...varint(input)];
    if (kind === "fixed64") return [...varint(field * 8 + 1), ...fixed64(input)];
    const body = Array.isArray(input) ? input : bytes(input);
    return [...varint(field * 8 + 2), ...varint(body.length), ...body];
  }
  const any = (value) => value.stringValue !== undefined ? wire(1, value.stringValue) :
    value.boolValue !== undefined ? wire(2, value.boolValue ? 1 : 0, "int") : wire(3, value.intValue, "int");
  const attribute = (entry, field) => wire(field, [...wire(1, entry.key), ...wire(2, any(entry.value))]);
  function protoRequest(signal, values) {
    const resource = wire(1, [...wire(1, "service.name"), ...wire(2, any({ stringValue: "apps-script" }))]);
    const scope = wire(1, "agent-platform");
    const records = values.map((value) => {
      const isSpan = signal === "spans";
      const entry = isSpan ? [wire(1, hex(value.traceId)), wire(2, hex(value.spanId)),
        value.parentSpanId ? wire(4, hex(value.parentSpanId)) : [], wire(5, value.name), wire(6, 1, "int"),
        wire(7, value.startTimeUnixNano, "fixed64"), wire(8, value.endTimeUnixNano, "fixed64"),
        ...value.attributes.map((item) => attribute(item, 9)), wire(15, wire(3, value.status.code, "int"))] :
        [wire(1, value.timeUnixNano, "fixed64"), wire(2, value.severityNumber, "int"),
          wire(5, any(value.body)), ...value.attributes.map((item) => attribute(item, 6)),
          wire(9, hex(value.traceId)), value.spanId ? wire(10, hex(value.spanId)) : []];
      return wire(2, [].concat(...entry));
    });
    return wire(1, [...wire(1, resource), ...wire(2, [...wire(1, scope), ...[].concat(...records)])]);
  }
  function jsonRequest(signal, values) {
    const span = signal === "spans";
    return JSON.stringify({ [span ? "resourceSpans" : "resourceLogs"]: [{
      resource: { attributes: attr({ "service.name": "apps-script" }) },
      [span ? "scopeSpans" : "scopeLogs"]: [{ scope: { name: "agent-platform" },
        [span ? "spans" : "logRecords"]: values }]
    }] });
  }
  function protoResponse(data) {
    if (data.length > 65536) throw new Error("Invalid OTLP response");
    let index = 0, rejected = 0;
    function number(end) {
      let value = 0, shift = 0, byte;
      do {
        if (index >= end || shift > 49) throw new Error("Invalid OTLP response");
        byte = data[index++] & 255;
        value += (byte & 127) * (2 ** shift);
        shift += 7;
      } while (byte & 128);
      if (!Number.isSafeInteger(value)) throw new Error("Invalid OTLP response");
      return value;
    }
    while (index < data.length) {
      if (number(data.length) !== 10) throw new Error("Invalid OTLP response");
      const end = index + number(data.length);
      if (end > data.length) throw new Error("Invalid OTLP response");
      while (index < end) {
        const field = number(end);
        if (field === 8) rejected = number(end);
        else if (field === 18) {
          index += number(end);
          if (index > end) throw new Error("Invalid OTLP response");
        } else throw new Error("Invalid OTLP response");
      }
    }
    return rejected;
  }
  function responseOutcome(response, name, signal, count) {
    const code = response.getResponseCode();
    if (code === 429) return { status: "retryable", accepted: 0, rejected: count };
    if (code < 200 || code >= 300) return {
      status: [400, 401, 403, 404, 413, 415, 422].includes(code) ? "failed" : "uncertain",
      accepted: 0, rejected: 0
    };
    try {
      let rejected;
      if (name === "honeycomb") {
        const raw = response.getContentText();
        if (raw.length > 65536) throw Error();
        const body = JSON.parse(raw);
        if (!body || Array.isArray(body) || Object.keys(body).some((key) => !["partialSuccess", "partial_success"].includes(key))) throw Error();
        const partial = Object.prototype.hasOwnProperty.call(body, "partialSuccess") ?
          body.partialSuccess : body.partial_success;
        if (partial !== undefined && (!partial || typeof partial !== "object" || Array.isArray(partial))) throw Error();
        const camel = signal === "spans" ? "rejectedSpans" : "rejectedLogRecords";
        const snake = signal === "spans" ? "rejected_spans" : "rejected_log_records";
        const explicit = partial === undefined ? undefined :
          Object.prototype.hasOwnProperty.call(partial, camel) ? partial[camel] : partial[snake];
        if (explicit !== undefined && !(typeof explicit === "number" && Number.isSafeInteger(explicit) ||
            typeof explicit === "string" && /^(0|[1-9]\d*)$/.test(explicit))) throw Error();
        rejected = explicit === undefined ? 0 : Number(explicit);
      } else rejected = protoResponse(response.getContent().map((byte) => byte & 255));
      if (!Number.isSafeInteger(rejected) || rejected < 0 || rejected > count) throw Error();
      return { status: rejected === count ? "failed" : rejected ? "partial" : "accepted",
        accepted: count - rejected, rejected };
    } catch { return { status: "uncertain" }; }
  }
  const periodKey = (period) => hash(JSON.stringify([period.start, period.end]));
  const counterKey = (period, name) => `${APP_TELEMETRY_PREFIX}USED_${name.toUpperCase()}_${periodKey(period)}`;
  const baselineKey = (period, name) => `${APP_TELEMETRY_PREFIX}BASELINE_${name.toUpperCase()}_${periodKey(period)}`;
  function registerPeriod(dest) {
    const key = `${APP_TELEMETRY_PREFIX}PERIODS_${dest.name.toUpperCase()}`;
    const previous = JSON.parse(properties.getProperty(key) || "[]");
    if (previous.some(([start, end]) =>
      (start !== dest.period.start || end !== dest.period.end) &&
      start < dest.period.end && dest.period.start < end))
      throw new Error("Invalid telemetry configuration: overlapping billing period");
    if (!previous.some(([start, end]) => start === dest.period.start && end === dest.period.end)) {
      if (previous.length >= 64) throw new Error("Telemetry billing period history capacity exhausted");
      previous.push([dest.period.start, dest.period.end]);
      properties.setProperty(key, JSON.stringify(previous));
    }
  }
  const usageKey = (period, name) => `${APP_TELEMETRY_PREFIX}COUNTS_${name.toUpperCase()}_${periodKey(period)}`;
  function addUsage(period, name, field, amount) {
    const key = usageKey(period, name);
    const counts = JSON.parse(properties.getProperty(key) ||
      '{"observed":0,"blocked":0,"attempted":0,"accepted":0,"failed":0,"dropped":0,"uncertain":0}');
    counts[field] = (counts[field] || 0) + amount;
    properties.setProperty(key, JSON.stringify(counts));
  }
  function locked(action) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try { return action(); } finally { lock.releaseLock(); }
  }
  function capture(options, receiptKey) {
    const config = settings();
    if (config.mode === "legacy") return false;
    if (!options || typeof options.traceId !== "string" || !options.traceId || options.traceId.length > 256 ||
        (options.operations && (!Array.isArray(options.operations) || options.operations.length > 16)))
      throw new Error("Invalid telemetry generation identity");
    const key = receiptKey || `${APP_TELEMETRY_PREFIX}TRACE_${hash(options.traceId)}`;
    const now = clock();
    if (!timestamp(now)) throw new Error("Invalid telemetry observation time");
    let state = locked(() => {
      for (const dest of config.destinations) {
        registerPeriod(dest);
        const keyForBaseline = baselineKey(dest.period, dest.name);
        const previous = Number(properties.getProperty(keyForBaseline) || "0");
        if (dest.otherUsage < previous) throw new Error("Invalid telemetry configuration: decreasing external usage");
        if (dest.otherUsage > previous) properties.setProperty(keyForBaseline, String(dest.otherUsage));
      }
      const saved = properties.getProperty(key);
      let next = saved ? JSON.parse(saved) : null;
      if (next?.destinations.length) return next;
      if (!next) {
        const observed = timestamp(options.endedMs) ? options.endedMs : now;
        const id = uuid(options.traceId, observed);
        const mapped = mapGeneration(options, observed, id);
        next = { id, periods: {}, destinations: [], mapped, signals: {}, status: "capacity_blocked",
          accounting: { observed: {}, blocked: {} } };
        if (JSON.stringify(next).length > 8500) throw new Error("Telemetry receipt exceeds Apps Script property limit");
        const keys = properties.getKeys().filter((name) => name.startsWith(APP_TELEMETRY_PREFIX));
        const telemetryBytes = keys.reduce((total, name) =>
          total + name.length + (properties.getProperty(name) || "").length, 0);
        const queued = keys.filter((name) => name.startsWith(`${APP_TELEMETRY_PREFIX}TRACE_`))
          .map((name) => properties.getProperty(name));
        const pending = queued.filter((value) => {
          const receipt = JSON.parse(value);
          return receipt.status === "capacity_blocked" ||
            Object.values(receipt.signals).some((signals) =>
              Object.values(signals).some((status) => status !== "accepted"));
        });
        if (pending.length >= 64 || pending.reduce((total, value) => total + value.length, 0) +
            JSON.stringify(next).length > 300 * 1024 ||
            telemetryBytes + key.length + JSON.stringify(next).length > 380 * 1024)
          throw new Error("Telemetry pending buffer capacity exhausted");
        // Persist sanitized evidence before inspecting free capacity or selecting a route.
        properties.setProperty(key, JSON.stringify(next));
      }
      next.accounting ||= { observed: {}, blocked: {} };
      for (const dest of config.destinations) {
        const period = periodKey(dest.period);
        if (next.accounting.observed[dest.name] !== period) {
          addUsage(dest.period, dest.name, "observed", next.mapped.units);
          next.accounting.observed[dest.name] = period;
          properties.setProperty(key, JSON.stringify(next));
        }
      }
      const mapped = next.mapped;
      const used = config.destinations.map((dest) =>
        Number(properties.getProperty(counterKey(dest.period, dest.name)) || "0"));
      const available = config.destinations.map((dest, index) =>
        dest.active && used[index] + mapped.units <= dest.limit);
      let destinations;
      if (config.mode === "mirror") destinations = available.every(Boolean) ?
        config.destinations.map((dest) => dest.name) : [];
      else {
        const eligible = config.destinations.filter((_dest, index) => available[index]);
        destinations = eligible.length ? [eligible[parseInt(key.slice(-8), 16) % eligible.length].name] : [];
      }
      if (!destinations.length) {
        for (const dest of config.destinations) {
          const period = periodKey(dest.period);
          if (next.accounting.blocked[dest.name] === period) continue;
          addUsage(dest.period, dest.name, "blocked", mapped.units);
          next.accounting.blocked[dest.name] = period;
          properties.setProperty(key, JSON.stringify(next));
        }
        return next;
      }
      next.attempts = {};
      for (const dest of destinations) {
        next.periods[dest] = config.destinations.find((item) => item.name === dest).period;
        next.signals[dest] = {};
        next.attempts[dest] = {};
        for (const signal of ["spans", "logs"]) if (mapped[signal].length) next.signals[dest][signal] = "reserved";
      }
      next.destinations = destinations;
      next.status = "routed";
      // Counters precede assignment: interruption wastes free quota, never exceeds it.
      for (const dest of destinations) {
        const counter = counterKey(next.periods[dest], dest);
        properties.setProperty(counter, String(Number(properties.getProperty(counter) || "0") + mapped.units));
      }
      properties.setProperty(key, JSON.stringify(next));
      return next;
    });
    if (!state) return false;
    for (const dest of config.destinations.filter((item) => state.destinations.includes(item.name))) {
      for (const signal of ["spans", "logs"]) {
        while (["reserved", "retryable"].includes(state.signals[dest.name][signal])) {
          if (state.signals[dest.name][signal] === "retryable") {
            try { Utilities.sleep(250 * (state.attempts[dest.name][signal] || 0)); }
            catch { break; }
          }
          // Persist in-flight before I/O: termination must never blindly replay it.
          const attempt = locked(() => {
            const latest = JSON.parse(properties.getProperty(key));
            const liveOtherValue = properties.getProperty(`${dest.name.toUpperCase()}_OTHER_USAGE`);
            const liveAllowanceValue = properties.getProperty(`${dest.name.toUpperCase()}_ALLOWANCE`);
            const liveStart = properties.getProperty(`${dest.name.toUpperCase()}_PERIOD_START`);
            const liveEnd = properties.getProperty(`${dest.name.toUpperCase()}_PERIOD_END`);
            const liveOther = Number(liveOtherValue);
            const liveAllowance = Number(liveAllowanceValue);
            const recordedPeriod = latest.periods[dest.name];
            const baseline = Math.max(liveOther, Number(properties.getProperty(
              baselineKey(recordedPeriod, dest.name)) || "0"));
            const used = Number(properties.getProperty(counterKey(recordedPeriod, dest.name)) || "0");
            if (periodKey(recordedPeriod) !== periodKey(dest.period) ||
                liveStart !== recordedPeriod.start || liveEnd !== recordedPeriod.end ||
                clock() < Date.parse(recordedPeriod.start) || clock() >= Date.parse(recordedPeriod.end) ||
                !/^(0|[1-9]\d*)$/.test(liveOtherValue || "") ||
                !/^(0|[1-9]\d*)$/.test(liveAllowanceValue || "") ||
                !Number.isSafeInteger(liveOther) || !Number.isSafeInteger(liveAllowance) ||
                used + baseline > liveAllowance || !["reserved", "retryable"].includes(latest.signals[dest.name][signal]))
              return 0;
            const number = (latest.attempts[dest.name][signal] || 0) + 1;
            if (number > 3) return 0;
            latest.attempts[dest.name][signal] = number;
            latest.signals[dest.name][signal] = "inflight";
            properties.setProperty(key, JSON.stringify(latest));
            const count = latest.mapped[signal].length;
            addUsage(recordedPeriod, dest.name, "attempted", count);
            addUsage(recordedPeriod, dest.name, "uncertain", count);
            return number;
          });
          if (!attempt) break;
          const values = state.mapped[signal];
          const isJson = dest.name === "honeycomb";
          const payload = isJson ? jsonRequest(signal, values) : protoRequest(signal, values);
          const result = (() => {
            try {
              const response = UrlFetchApp.fetch(dest.endpoint + "/v1/" + (signal === "spans" ? "traces" : "logs"), {
                method: "post", contentType: isJson ? "application/json" : "application/x-protobuf",
                headers: isJson ? { "x-honeycomb-team": dest.credential } : { Authorization: dest.credential },
                payload: isJson ? payload : Utilities.newBlob(payload.map((byte) => byte > 127 ? byte - 256 : byte)).getBytes(),
                muteHttpExceptions: true, followRedirects: false
              });
              return responseOutcome(response, dest.name, signal, values.length);
            } catch { return { status: "uncertain", accepted: 0, rejected: 0 }; }
          })();
          locked(() => {
            const latest = JSON.parse(properties.getProperty(key));
            if (latest.signals[dest.name][signal] !== "inflight") return;
            const period = latest.periods[dest.name];
            const count = values.length;
            const status = result.status === "retryable" && attempt === 3 ? "failed" : result.status;
            latest.signals[dest.name][signal] = status;
            if (status !== "uncertain") addUsage(period, dest.name, "uncertain", -count);
            if (result.accepted) addUsage(period, dest.name, "accepted", result.accepted);
            if (result.status === "retryable" || status === "failed" || status === "partial")
              addUsage(period, dest.name, "failed", status === "partial" ? result.rejected : count);
            if (status === "failed") {
              const counter = counterKey(period, dest.name);
              properties.setProperty(counter, String(Math.max(0,
                Number(properties.getProperty(counter) || "0") - count)));
            }
            if (latest.destinations.every((name) =>
              Object.values(latest.signals[name]).every((value) => value === "accepted")))
              latest.mapped = null;
            properties.setProperty(key, JSON.stringify(latest));
            state = latest;
          });
        }
      }
    }
    return state.status === "routed" && state.destinations.every((dest) =>
      Object.values(state.signals[dest]).every((status) => status === "accepted"));
  }
  /** Operator-triggered only: pending unsent signals survive invocation termination. */
  function drain() {
    if (settings().mode === "legacy") return 0;
    let attempted = 0;
    const keys = properties.getKeys().filter((key) => key.startsWith(`${APP_TELEMETRY_PREFIX}TRACE_`));
    for (const key of keys) {
      if (attempted >= 20) break;
      const saved = JSON.parse(properties.getProperty(key));
      if (!saved || (saved.status !== "capacity_blocked" &&
          !Object.values(saved.signals).some((signals) =>
            Object.values(signals).includes("reserved") || Object.values(signals).includes("retryable")))) continue;
      capture({ traceId: "pending" }, key);
      attempted++;
    }
    return attempted;
  }
  /** Sanitized local capacity and unresolved-delivery readback, independent of credentials. */
  function getUsage() {
    return locked(() => {
      const destinations = ["honeycomb", "logfire"].map((name) => {
        const windows = JSON.parse(properties.getProperty(
          `${APP_TELEMETRY_PREFIX}PERIODS_${name.toUpperCase()}`) || "[]");
        return { name, periods: windows.map(([start, end]) => {
          const period = { start, end };
          return { period, counts: JSON.parse(properties.getProperty(usageKey(period, name)) ||
              '{"observed":0,"blocked":0,"attempted":0,"accepted":0,"failed":0,"dropped":0,"uncertain":0}'),
            reserved: Number(properties.getProperty(counterKey(period, name)) || "0"),
            baseline: Number(properties.getProperty(baselineKey(period, name)) || "0") };
        }) };
      });
      const pending = { capacity_blocked: 0, reserved: 0, retryable: 0, inflight: 0,
        partial: 0, uncertain: 0, failed: 0 };
      for (const key of properties.getKeys().filter((value) =>
        value.startsWith(`${APP_TELEMETRY_PREFIX}TRACE_`))) {
        const receipt = JSON.parse(properties.getProperty(key));
        if (!receipt.mapped) continue;
        if (receipt.status === "capacity_blocked") { pending.capacity_blocked++; continue; }
        for (const signals of Object.values(receipt.signals))
          for (const status of Object.values(signals))
            if (Object.prototype.hasOwnProperty.call(pending, status)) pending[status]++;
      }
      return { destinations, pending };
    });
  }
  return { capture, drain, getUsage };
}
