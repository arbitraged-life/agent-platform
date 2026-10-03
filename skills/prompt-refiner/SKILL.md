---
name: prompt-refiner
description: Turn ambiguous or multi-system requests into explicit execution directives with bounded assumptions, acceptance criteria, and optional adapters, without persisting raw prompts by default.
---

# Prompt Refiner

Use when a request is ambiguous enough that execution would otherwise rely on hidden assumptions, or when multiple systems need a shared implementation contract.

Do not invoke refinement for already-clear, bounded tasks.

## Refinement contract

Produce a structured directive containing:
1. objective;
2. known inputs and authoritative sources;
3. constraints and non-goals;
4. unresolved assumptions;
5. execution steps or work packages;
6. acceptance criteria;
7. verification method;
8. explicit side effects or permissions required.

Refinement clarifies work; it does not grant additional authority.

## Adapter boundary

A refiner and an executor are separate capabilities. If an external adapter is used, identify its exact executable or API contract and invoke it without shell-fragment interpolation.

Do not claim a prompt was refined merely because placeholders were substituted or the original text was echoed.

## Persistence

Raw requests, refined prompts, and execution results may contain sensitive data. Do not write them to logs, hidden project directories, telemetry, or evaluation fixtures unless persistence is explicitly requested and the destination is appropriate.

## Evaluation

When evaluating refinement quality, use reproducible fixtures and assertions that test whether important constraints and acceptance criteria survive the transformation. Keep repository-specific policy out of the generic skill; consumers may add local overlays.

## Output

Return the refined directive and clearly mark any assumptions that still require a decision. Do not silently execute the refined prompt unless execution was also requested and authorized.
