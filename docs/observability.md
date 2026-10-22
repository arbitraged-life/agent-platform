# Observability contract v1

`runtime/observability/records.mjs` normalizes OMP and OpenCode/Kilo turns into the same
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

The exporter returns per-resource acceptance receipts. A partial Opik failure retains
accepted resource IDs so a retry can skip them. `runtime/observability/outbox.mjs`
provides an opt-in durable, bounded queue; the private adapter owns its location.
Only explicit HTTP 429 nonacceptance is eligible for bounded retry. Authentication,
approval, safety and ambiguous transport failures are terminal. An interrupted
in-flight entry remains uncertain and is never automatically replayed. Stable IDs
support correlation and PostHog deduplication; they are not an exactly-once guarantee.

The Opik mapping follows the
[create-span API](https://www.comet.com/docs/opik/reference/rest-api/spans/create-span):
UUID IDs and integer usage values. Validated producer-reported USD cost is retained
in structured metadata and, when known, copied to the span's `total_estimated_cost`;
a reported zero is preserved and unknown cost is omitted. Known cache and
reasoning counts are exported without recomputing provider-reported token totals.
See [Opik usage and known-cost projection](observability-cost-projection.md) for
the exact mapping and consumer rollout boundary.

Runtime modules live in `runtime/observability/`. Event timestamps use canonical
UTC ISO strings with exactly three fractional digits. JSON Schema validates
structure and scalar constraints; `validateEvent` additionally checks cross-field
time and count relationships. Schema-only validation is not the export gate.
Event IDs use UUIDv7, including caller-supplied IDs.
The model span preserves the event timestamp and uses deterministic namespaced
random bits derived from the event ID,
so repeated submissions retain both identities. Duplicate-conflict responses still
surface as failures; stable IDs do not imply durable delivery or automatic recovery.

Opik requires [UUIDv7 ingestion IDs](https://www.comet.com/docs/opik/self-host/configure/uuid_validation). Destination timestamp windows can reject historical replay; this exporter preserves event time and surfaces rejection rather than rewriting history.


## Operational control-plane export

Opik remains the detailed AI trace and evaluation destination. PostHog is a separate,
privacy-safe operational projection intended for cross-system dashboards and trend
analysis. `runtime/observability/posthog.mjs` validates the same canonical
`agent.turn.completed` event, then emits one `personal_os_agent_turn_completed`
event containing only normalized metadata.

The PostHog projection includes the canonical event/run/task IDs, runtime, agent,
model/provider, status, duration, attempt, tool counts, usage totals, reported cost,
and `opik_trace_id`. The Opik trace ID is exactly the canonical event UUID, so a
dashboard record can drill into the corresponding detailed trace without copying
prompts, responses, tool arguments, paths, raw exceptions, or credentials into
PostHog.

PostHog configuration is explicit and versioned through
`schemas/posthog-config.schema.json`. It contains the HTTPS capture endpoint, the
environment-variable name holding the project token, and a stable pseudonymous
`distinct_id`; it never contains the token itself. The exporter refuses redirects,
bounds request time, snapshots and validates the event before network activity, and
does not include provider response bodies in errors.

This split is intentional:

- **PostHog**: Personal OS / cross-system operational events, dashboards, trends.
- **Opik**: detailed agent/LLM traces, datasets, evaluations, experiments.
- **External ledger**: durable scheduled-run/acceptance records where the private
  deployment defines one.

The PostHog exporter is a secondary projection. Private consumers decide whether a
PostHog delivery failure is blocking or fail-open; the public module itself always
reports delivery failure rather than fabricating success.


## Execution-efficiency analysis

The instrumented operation evidence and completed-turn telemetry can be analyzed
without sharing prompts, tool arguments, paths, or raw outputs:

```sh
node scripts/observability/efficiency.mjs /path/to/authorized-records.json
```

The input is an array of canonical `agent.turn.completed` and
`agent.evidence` records, or an object with a `records` array. Every
record must validate against its existing strict schema. The reducer
deduplicates verified effects by `action_key` (falling back to the
tool-call/event ID); an operation only counts when its
`verification_status` is `verified`. This is a **verified action**
rate, not an inferred count of changed files or a measure of user satisfaction.

The output includes measured tool calls, verified actions, failure counts,
duration, coverage gaps, and `tool_calls_per_verified_action`. The latter
is `null` when any included successful turn has missing tool counts,
no verified actions, or conflicting evidence. Production-only filtering
excludes synthetic evidence; do not mix experimental data with production.
The reducer neither creates events nor captures activity. Connectors need
actual instrumented hooks and delivery receipts before their actions can
be counted. Ordinary ChatGPT conversation execution and generic third-party
connector calls are **not** automatically captured by this runtime.

The Opik `chatgpt-execution-routing-regressions` dataset contains a
manual, non-production encrypted-Vault-editing regression example from
2026-10-13. It is not evidence of automatic capture, production
improvement, or a measured baseline.

## Operation evidence and delivery receipts

`schemas/telemetry-evidence.schema.json` is a separate versioned contract. It permits
lifecycle timestamps, tool names, opaque action/attempt references, explicit
failure boundary, provenance and verification status. It rejects arbitrary fields.
Arguments, raw errors, outputs, filesystem paths and credentials remain excluded.
`evidence_origin=mechanically_captured` means the adapter observed the exposed hook
payload; middleware may have modified that payload. It is not an independent host
audit. A successful tool result has `verification_status=not_verified` until an
application explicitly verifies its effect.

A start creates one Opik trace. Operation observations create tool spans under that
trace. A terminal record updates the same trace and optionally includes validated
turn metrics, from which one model span is created. Final metrics use the same trace
ID in PostHog. An interrupted turn records unknown, never successful completion.
Tool failures without an observable boundary remain `failure_stage=unknown`.
Native Opik error fields carry only a controlled outcome/stage summary.

PostHog receives `agent_turn_started`, `agent_operation_observed`, and either
`personal_os_agent_turn_completed` (measured terminal metrics) or
`agent_turn_finished` (unknown shutdown without metrics). Join starts to terminals
by `trace_id` / `opik_trace_id`, not session-level `run_id`. Each turn has its own
trace ID. Missing tool counts and usage remain null; recorded zero remains zero.

A private destination fan-out returns `agent.delivery` receipts independently for
Opik and PostHog. `accepted` means the ingestion request returned success;
`readback_status=not_checked` makes clear that visibility was not verified. HTTP
codes are preserved as provider evidence; raw bodies are deliberately excluded.
Exceptions without a safe exposed code retain unavailable provenance. A failed
sink never erases another sink's success.

The private integration may project a strict `personal_os_telemetry_delivery` event
to PostHog after its original ingestion succeeds. It includes only destination
status, readback state, controlled reason code, failure stage, and retry eligibility.
That projection does not recursively log its own delivery. A projection failure
stays in the local receipt; reporting has a visibility gap when PostHog itself is
unavailable.

The queue defaults to 512 records, three attempts, one-minute exponential retry,
and seven-day delivered-evidence retention. Delivered records may be evicted to
make capacity, and the returned receipt includes `evicted_delivered_count`.
Unresolved failures are retained; a full queue rejects new intake visibly. Local
files use owner-only permissions, no-follow reads, atomic replacement and exclusive
claims. Persistence runs independently of slow network delivery. Consumers can
flush persistence before a bounded shutdown wait, then drain eligible records at
next startup. Abandoned claims require review; the queue never guesses whether a
remote mutation succeeded.

Native OMP payload references (inspected 2026-10-12):
[shared events](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/shared-events.ts),
[extension events](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/extensibility/extensions/types.ts),
[message stop reasons](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/types.ts).
The consuming deployment must verify its installed version before claiming native
runtime acceptance. Synthetic hook fixtures demonstrate adapter behavior only.
