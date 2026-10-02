---
name: repository-systematic-audit
description: Audit repository ownership, dependencies, duplicates and migration risks before changing structure.
---

# Repository systematic audit

Start with evidence. Inventory tracked, untracked and ignored state, branches,
worktrees, runtime consumers, schedules, generated files and external interfaces.
Record the source revision and dirty-path fingerprints without exposing secrets.
Do not relocate apparently unused files merely to make the tree look cleaner.

For each significant component record responsibility, owner, visibility,
consumers, dependencies, duplicates, drift, intended canonical form, target,
validation, privacy risk and history value. Distinguish reusable behavior from
environment policy and independently owned knowledge.

Compare duplicate implementations by behavior and tests. Choose the canonical
implementation before moving either copy. Trace imports, configuration
renderers, installed links, deployment definitions and remote workflow callers;
a text search alone cannot establish that a component is unused.

Produce a machine-readable inventory and a short report covering the target
structure, explicit dependency contract, intended removals and unresolved
questions. Each removal candidate needs an exact path, reason, fingerprint,
consumer evidence and rollback strategy. Unknown ownership remains unresolved.

The execution sequence is audit, normalize, migrate, validate, cut over, then
retire obsolete state. Existing task authorization applies; ask only when a
consequential unresolved choice exceeds that authorization. Continue independent
auditing while a decision is pending.

Use [repository-safe-cleanup](../repository-safe-cleanup/SKILL.md) for approved
changes, [cleanup-verification-qa](../cleanup-verification-qa/SKILL.md) for
independent checks and [aggressive-repository-cleanup](../aggressive-repository-cleanup/SKILL.md)
for validated final removals. Report evidence through
[status-report](../status-report/SKILL.md).
