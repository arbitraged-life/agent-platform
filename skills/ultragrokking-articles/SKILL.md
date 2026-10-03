---
name: ultragrokking-articles
description: Analyze long-form technical material against a concrete engineering problem, separate source claims from inference, and derive proportionate verification or guardrail options.
---

# Deep Technical Article Analysis

Use when a paper, article, specification, or long documentation set must inform a concrete engineering decision rather than merely be summarized.

## Workflow

1. Identify the user's target problem and decision.
2. Extract the source's claims, evidence, assumptions, and stated limitations.
3. Separate directly supported statements from your own synthesis.
4. Map relevant claims to the current system only where the source actually applies.
5. Identify contradictions, missing evidence, and transferability risks.
6. Derive practical experiments, checks, or guardrail options.
7. Recommend implementation only when the evidence justifies it.

## Guardrail design

Executable enforcement is one possible outcome, not a mandatory one.

Prefer the lightest mechanism that reliably prevents the demonstrated failure:
- an existing linter rule;
- a configuration constraint;
- a focused test;
- a CI assertion;
- a small custom validator only when simpler mechanisms are insufficient.

Do not create new linters, hooks, or CI gates merely to make the analysis feel actionable.

## Verification

Before proposing a tool or rule:
- verify that the tool or mechanism exists in the target environment;
- show which source claim or observed failure it addresses;
- define a failing example and a passing example;
- state operational cost and false-positive risk.

## Deliverable

Produce:
- problem-to-source mapping;
- evidence and limitations;
- proposed experiments or checks;
- optional enforcement mechanisms;
- unresolved questions.

Preserve citations or source references needed to trace important claims.
