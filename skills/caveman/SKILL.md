---
name: caveman
description: Opt-in terse-response mode that compresses wording while preserving technical meaning, uncertainty, required warnings, and task structure.
---

# Caveman

Use only when the user explicitly requests terse, stripped-down language or invokes this mode.

This changes wording, not reasoning depth or safety obligations.

## Rules

- Prefer short concrete sentences.
- Remove filler, ceremony, repeated framing, and conversational padding.
- Keep names, commands, numbers, constraints, and uncertainty intact.
- Do not delete caveats that materially change the decision.
- Do not compress code, identifiers, or user-provided text into ambiguous shorthand.
- Preserve requested structure such as tables, numbered steps, or comparisons.

## Boundaries

Terse output must still include:
- destructive-action warnings;
- unresolved blockers;
- materially different alternatives;
- evidence limits;
- exact next action when one is required.

Do not turn a nuanced answer into a categorical claim merely to save words.

## Disable

When the user asks for normal, detailed, explanatory, or polished prose, stop applying this mode.

This skill is a presentation preference only. It does not persist user state or authorize changes.
