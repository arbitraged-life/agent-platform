---
name: headroom
description: Evaluate and use context-compression tooling with reproducible fixtures, explicit losslessness checks, bounded installation, and clear separation between library and proxy interception.
---

# Headroom

Use when large tool output, logs, retrieval results, or structured data may benefit from compression before entering model context.

## Decision boundary

Prefer ordinary filtering, pagination, field selection, or targeted reads before adding a compression dependency. Use compression only when it measurably reduces context while preserving the information required for the task.

## Evaluation

1. Pin the exact candidate version.
2. Evaluate in an isolated environment without host credentials or writable project mounts.
3. Use representative payloads from the intended workload, including wrapped objects as well as flat arrays.
4. Measure raw size, baseline minification, compressed size, and elapsed time using the same tokenizer or byte metric.
5. Verify recoverability of required fields by parsing the compressed representation; substring matching is not a losslessness test.
6. Record unsupported shapes, fallback behavior, and any dependencies loaded by optional extras.

Do not repeat vendor benchmark claims as local evidence.
## Library vs interception

A library call that transforms an already-available string has a narrower trust boundary than a proxy or agent wrapper.

Before enabling proxy/wrapper mode, disclose that it can observe prompts, tool output, and credentials passing through the model transport. Do not enable interception merely to obtain compression statistics.

## Installation

Use an exact version or immutable artifact. Do not install optional ML/proxy extras unless the requested path needs them. Prefer an isolated environment for first use.

## Acceptance

Adopt only when:
- the target payload class shows material savings beyond trivial minification;
- required content is recoverable;
- failure/fallback behavior is understood;
- latency and dependency cost are acceptable;
- the chosen operating mode has an explicit data boundary.

If a representative payload receives no benefit, report that result instead of generalizing from an easier fixture.
