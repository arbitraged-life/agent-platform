import { stableEvidenceId } from "./evidence.mjs";
/** Export errors carry only controlled fields, never raw response text. */
export class DeliveryError extends Error {
  constructor({
    code = "EXPORT_FAILED",
    stage = "telemetry_export",
    status = "failed",
    retryable = false,
    httpStatus = null,
    acceptedRecords = [],
  } = {}) {
    super(
      code === "TRANSPORT_UNCERTAIN"
        ? "Telemetry transport failed"
        : `Telemetry ingestion failed (${httpStatus ?? code})`,
    );
    this.receipt = {
      delivery_status: status,
      readback_status: "not_checked",
      reason_code: code,
      reason_provenance: httpStatus === null ? "unavailable" : "raw_provider_error",
      reason_safe: httpStatus === null ? null : `HTTP ${httpStatus}`,
      failure_stage: stage,
      retryable,
      http_status: httpStatus,
      accepted_records: [...acceptedRecords],
    };
  }
}
export function failedReceipt(error) {
  return error instanceof DeliveryError
    ? { ...error.receipt }
    : {
        delivery_status: "failed",
        readback_status: "not_checked",
        reason_code: "EXPORT_FAILED",
        reason_provenance: "unavailable",
        reason_safe: null,
        failure_stage: "telemetry_export",
        retryable: false,
        http_status: null,
        accepted_records: [],
      };
}
export function disabledExporter(status = "disabled") {
  return Object.assign(
    async () => ({
      status,
      delivery_status: status,
      readback_status: "not_checked",
      reason_code: status === "misconfigured" ? "CONFIGURATION_UNAVAILABLE" : null,
      reason_provenance: "unavailable",
      reason_safe: null,
      failure_stage: status === "misconfigured" ? "input_validation" : "none",
      retryable: false,
      accepted_records: [],
    }),
    { configurationStatus: status },
  );
}
export async function sendTelemetry(fetcher, url, options, acceptedRecords = []) {
  let response;
  try {
    response = await fetcher(url, options);
  } catch {
    throw new DeliveryError({ code: "TRANSPORT_UNCERTAIN", status: "uncertain", acceptedRecords });
  }
  if (!response.ok) {
    const httpStatus = response.status;
    const denied = httpStatus === 401 || httpStatus === 403;
    // Only an explicit rate-limit rejection proves this request was not accepted.
    throw new DeliveryError({
      code: `HTTP_${httpStatus}`,
      httpStatus,
      stage: denied ? "connector_authentication" : "telemetry_export",
      status: denied ? "denied" : httpStatus >= 500 ? "uncertain" : "failed",
      retryable: httpStatus === 429,
      acceptedRecords,
    });
  }
  return response;
}
export function acceptedReceipt(eventId, acceptedRecords = []) {
  return {
    status: "delivered",
    delivery_status: "accepted",
    readback_status: "not_checked",
    event_id: eventId,
    record_id: eventId,
    reason_code: null,
    reason_provenance: "unavailable",
    reason_safe: null,
    failure_stage: "none",
    retryable: false,
    accepted_records: acceptedRecords,
  };
}

const DELIVERY_FIELDS = ["delivery_status", "readback_status", "reason_code", "failure_stage", "retryable"];
export function deliveryRecord(event, receipt) {
  const destinations = {};
  for (const [name, value] of Object.entries(receipt.destinations).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    destinations[name] = Object.fromEntries(
      DELIVERY_FIELDS.map((key) => [key, value[key] ?? (key === "retryable" ? false : null)]),
    );
  }
  return validateDeliveryRecord({
    schema_version: 1,
    record_type: "agent.delivery",
    event_id: stableEvidenceId(event.event_id, "delivery:" + JSON.stringify(destinations)),
    source_event_id: event.event_id,
    trace_id: event.trace_id ?? event.event_id,
    runtime: event.runtime ?? event.records?.[0]?.runtime,
    run_id: event.run_id ?? event.records?.[0]?.run_id,
    observed_at: receipt.observed_at,
    recorded_at: receipt.recorded_at,
    destinations,
  });
}
export function validateDeliveryRecord(record) {
  const fields = [
    "schema_version",
    "record_type",
    "event_id",
    "source_event_id",
    "trace_id",
    "runtime",
    "run_id",
    "observed_at",
    "recorded_at",
    "destinations",
  ];
  if (
    !record ||
    record.schema_version !== 1 ||
    record.record_type !== "agent.delivery" ||
    Object.keys(record).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(record, key))
  )
    throw new Error("Invalid delivery fields");
  for (const name of ["event_id", "source_event_id", "trace_id"])
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record[name]))
      throw new Error("Invalid delivery identity");
  for (const name of ["run_id", "runtime"])
    if (typeof record[name] !== "string" || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(record[name]))
      throw new Error("Invalid delivery reference");
  for (const name of ["observed_at", "recorded_at"])
    if (
      typeof record[name] !== "string" ||
      !Number.isFinite(Date.parse(record[name])) ||
      new Date(Date.parse(record[name])).toISOString() !== record[name]
    )
      throw new Error("Invalid delivery time");
  const destinationNames = Object.keys(record.destinations ?? {});
  if (!record.destinations || typeof record.destinations !== "object" ||
      Array.isArray(record.destinations) ||
      ![1, 2].includes(destinationNames.length) ||
      !(
        (destinationNames.includes("opik") && destinationNames.includes("posthog")) ||
        destinationNames.every(name => ["honeycomb", "logfire"].includes(name))
      ))
    throw new Error("Invalid delivery destinations");
  for (const value of Object.values(record.destinations)) {
    if (
      Object.keys(value).length !== DELIVERY_FIELDS.length ||
      DELIVERY_FIELDS.some((key) => !Object.hasOwn(value, key))
    )
      throw new Error("Invalid destination fields");
    if (
      !["accepted", "failed", "uncertain", "denied", "disabled", "misconfigured", "capacity_blocked"].includes(
        value.delivery_status,
      ) ||
      !["not_checked", "verified", "pending", null].includes(value.readback_status) ||
      typeof value.retryable !== "boolean" ||
      (value.reason_code !== null &&
        !/^(HTTP_[1-5][0-9]{2}|EXPORT_FAILED|TRANSPORT_UNCERTAIN|CONFIGURATION_UNAVAILABLE|CAPACITY_BLOCKED)$/.test(
          value.reason_code,
        )) ||
      ![null, "none", "input_validation", "connector_authentication", "telemetry_export"].includes(
        value.failure_stage,
      )
    )
      throw new Error("Invalid destination outcome");
  }
  return record;
}
