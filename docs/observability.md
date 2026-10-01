# Observability contract v1

`observability/records.mjs` normalizes OMP and OpenCode/Kilo turns into the same
schema: `schemas/telemetry-event.schema.json`. A run identifies a runtime session;
a task is an optional caller-supplied work identifier. An agent is distinct from
a model and its provider. Attempt numbers start at one. Durations use milliseconds,
cost uses USD, and token counts are nonnegative integers. Unknown measurements
stay null; a reported zero stays zero. Provider totals are preserved because
cache and reasoning token inclusion varies between runtimes.

The event records one completed turn, its status, timing, tool-call/failure counts,
and model usage. It excludes prompts, responses, working directories, tool arguments,
tool names, raw exceptions, credentials, and arbitrary metadata. Identifiers are
caller-provided opaque identifiers; private policy controls their values. Content
capture from older adapters is intentionally not part of this structured event
contract. Private opt-in content pipelines require separate redaction and review.

`openAgentEvent` and `ompEvent` adapt existing runtime records. `turnEvent` constructs
records for other adapters. `createOpikExporter` uses one shared trace/span mapping,
validates events before sending, requires HTTPS, refuses redirects, bounds request
time, and reports errors without provider response bodies or exception messages.
It never reads a home directory or discovers credentials implicitly. Missing
credentials are configuration failures, not fabricated successful deliveries.

An explicit private configuration contains `schema_version: 1`, `endpoint`,
`workspace`, `project`, and `credential_env`. It contains a credential environment
variable name, never its value. All five fields are required; unknown fields and
versions fail. Validate without accessing a credential or network:

```sh
node scripts/observability/config.mjs validate path/to/private-config.json
```

The current exporter sends a trace and then its span. There is no durable delivery
queue or automatic retry: a partial failure is surfaced to the caller and must not
be reported as successful delivery. Event IDs permit caller correlation. This is
an extracted normalization interface; active source harnesses remain unchanged
until their lifecycle adapters, shutdown/drain behavior, and private destinations
pass component acceptance and consumers move to an immutable release.

The Opik mapping follows the [create-span API](https://www.comet.com/docs/opik/reference/rest-api/spans/create-span): UUID IDs and integer usage values. Reported USD cost remains explicit metadata rather than being silently presented as a provider estimate.
