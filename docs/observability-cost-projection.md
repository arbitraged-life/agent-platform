# Opik usage and known-cost projection

`runtime/observability/opik.mjs` forwards validated producer-reported cost to
Opik's writable `total_estimated_cost` field. A real zero is preserved; unknown
cost is omitted, not priced from incomplete usage or assigned zero.

The span `usage` map carries `prompt_tokens`, `completion_tokens`, and reported
`total_tokens`, plus available `reasoning_tokens`, `cache_read_tokens`, and
`cache_write_tokens`. These are integer counts; the raw structured event is also
preserved in metadata. Do not sum input and output to overwrite reported totals:
provider totals may include cached or other token classes.

Reference contracts:
- https://www.comet.com/docs/opik/reference/rest-api/spans/create-span
- https://www.comet.com/docs/opik/tracing/advanced/cost_tracking

## Verification

Run `node --test tests/unit/observability*.test.mjs`. Regression fixtures cover
known nonzero cost, true zero, omitted unknown fields, cache/reasoning counts,
producer totals, metadata preservation, and stable trace/span identities.

A bounded hosted acceptance test used one synthetic event in an existing test
project, without invoking a model: input=200, output=20, cache-read=800,
reported-total=1020, known synthetic cost=0.05. Independent span readback retained
those fields and the filtered native `span_cost` metric returned 0.05. This is a
synthetic fixture value, not real inference spending.

## Release boundary

The consuming private repository must pin and deploy an accepted release before
normal agent traces use the mapping. Merging this change alone does not update
installed consumers or backfill historical traces. Preserve runtime provider
identity and reported-cost provenance; estimated cost is not a subscription bill.
No prompts, responses, credentials, paths or user trace IDs are needed in this
public regression fixture.
