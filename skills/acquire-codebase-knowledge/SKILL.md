---
name: acquire-codebase-knowledge
description: Build a bounded evidence-based map of an unfamiliar codebase using tracked-file discovery, containment-safe reads, targeted search, and explicit coverage limits.
---

# Acquire Codebase Knowledge

Use when an agent needs enough repository context to plan or modify code safely without
trying to ingest the entire tree.

## Safety and containment

Start from the intended repository root. When Git is available, prefer tracked-file
inventory (`git ls-files`) over unrestricted filesystem traversal. Do not follow symlinks
outside the repository or read credential-shaped files merely because they exist.

Treat `.env*`, private keys, credential stores, build caches, dependency directories,
generated output, databases, and large/binary assets as excluded unless the task specifically
requires them and access is authorized.

For non-Git directories, keep traversal physically contained under the selected root and do
not follow directory symlinks.

## Bounded discovery

1. Read top-level project/contribution/build metadata and the smallest relevant architecture
   documentation.
2. Inventory tracked paths and major source/test/config directories without reading every
   file.
3. Search for task-specific symbols, routes, interfaces, tests, and configuration keys.
4. Read bounded regions around relevant matches, expanding only when needed to understand
   control flow or contracts.
5. Follow imports/dependencies selectively to the next meaningful boundary.

Do not read entire large files before deciding what slice is needed. Do not traverse the
whole repository and truncate only after the fact.

## Build a working map

Capture only evidence useful to the task:

- entrypoints and major modules;
- relevant data/control flow;
- public interfaces and dependency boundaries;
- repository-specific conventions;
- build/test/lint commands actually defined by the repo;
- tests that demonstrate expected behavior;
- unknowns that still require inspection.

Distinguish observed facts from inference. A missing search result may mean the search scope
was incomplete; it is not proof that the concept does not exist.

## Verification before implementation

Before editing, verify that the planned files are inside the intended repository and that
the chosen tests/commands really exist. Re-check relevant context after large branch or
dependency changes rather than relying on a stale map.

## Report

Summarize the files/areas inspected, the resulting codebase map, important conventions,
task-relevant tests/commands, and explicit coverage gaps. Do not present a bounded scan as
complete repository understanding.
