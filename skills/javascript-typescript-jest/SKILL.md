---
name: javascript-typescript-jest
description: Write and review focused JavaScript or TypeScript Jest tests with explicit mock lifecycle, deterministic async behavior, and repository-consistent structure.
---

# JavaScript / TypeScript Jest Testing

Use for Jest tests in JavaScript or TypeScript repositories. Repository-local test
conventions and configured transforms/environments take precedence over generic advice.

## Test design

Prefer tests that establish externally observable behavior and failure modes over tests
that mirror implementation details.

- Give each test one clear behavioral claim.
- Keep fixtures small and local unless shared fixtures materially reduce duplication.
- Cover success, meaningful boundary cases, and relevant failures.
- Prefer deterministic inputs; do not depend on wall-clock time, network access, random
  data, or global process state unless the test explicitly controls them.
- Add regression tests for bugs at the narrowest layer that reliably reproduces the issue.

For TypeScript, keep test code type-correct under the repository's normal configuration
rather than weakening types just to satisfy a mock.

## Mock lifecycle

Choose the least destructive cleanup operation that matches the test:

- `jest.clearAllMocks()` clears call/instance/result history while keeping mock
  implementations.
- `jest.resetAllMocks()` also resets mock implementations to their default mock state.
- `jest.restoreAllMocks()` restores original implementations for spies/replaced properties
  that Jest can restore.

Do not use reset when clear is sufficient, and do not assume reset restores the original
real implementation. Restore spies after tests that replace real methods.

Prefer dependency injection or narrow spies to broad module mocking when practical. Mock
external boundaries, not the unit's own logic.

## Async and timers

Await promises and async user interactions explicitly. Use rejection/resolution matchers
only when they make the assertion clearer. For fake timers, opt in per test/suite and restore
real timers afterward. Advance timers deliberately and flush pending microtasks when the
code under test requires it.

Avoid arbitrary sleeps. A timeout increase is not a substitute for deterministic
synchronization.

## UI tests

For DOM/React tests, prefer user-observable behavior and accessible queries. Use the
repository's installed testing library rather than adding a new test stack without need.
Snapshots are appropriate only when a compact, stable representation is itself the
contract; review snapshot diffs as carefully as code diffs.

## Verification

Run the narrow affected Jest target first, then the repository's normal broader test or
validation command when the change warrants it. Report skipped suites, environment
limitations, and whether coverage was focused or full.
