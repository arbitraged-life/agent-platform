---
name: skill-audit
description: Evaluate agentic skills for overlap, quality, coverage, and compliance with architectural and purity standards.
---

# Skill Audit and Evaluation Skill (`skill-audit`)

## When to Use This Skill

Use this skill when the user asks:
- "Audit my skill zoo and tell me which ones are overlapping."
- "Evaluate skill X and design a test plan for it."
- "How do I set up prompt evaluation or Promptfoo tests for these skills?"
- "We need to tournament-test our planning skills and pick a winner."
- "Add a new skill and verify its compliance with repository purity standards."

The objective is to analyze skill files, detect overlaps, design rigorous unit-test probes, configure automated evaluations, and recommend keeping, merging, or archiving capabilities.

## Workflow

### 📋 Step 1: Extract and Catalog Metadata
1. Locate and read the target skill files (e.g., `SKILL.md` or `skill_name.md`).
2. Extract key components:
   - **Trigger prompts** (the `Use when...` or trigger lines).
   - **Required inputs and outputs** (structure, schemas, file templates).
   - **Underlying scripts** (shell scripts, python adapters, binaries).
   - **Purity constraints** (any dependency on sync-blocking operations, root directories, etc.).

### 🔍 Step 2: Conduct Overlap Analysis
1. Cross-reference the target skill against the repository’s declared skill catalog/index when one exists; otherwise inventory the relevant skill roots explicitly.
2. Look for overlapping triggers, functional categories, or similar outputs.
3. Classify the conflict type:
   - **Semantic trigger overlap** (different names, identical triggers).
   - **Stack-level overlap** (different tools, same high-level purpose).
   - **Scope overlap** (different granularity, overlapping domain).

### 🧪 Step 3: Design the "Tournament" Test Suite
For the target skills, design three specific probe test cases to evaluate quality and compliance:
1. **Small task** (Refactoring/Mechanical): Checks fine-grained precision, syntax correctness, and obedience to strict formats.
2. **Medium project** (Modular Design): Checks structural layout, API boundary clarity, and logical consistency.
3. **Tricky/Ambiguous project** (Edge Case/Ambiguity): Checks how the skill handles missing requirements, vague instructions, or conflicting constraints without guessing.

### 🤖 Step 4: Configure Automated Prompt Evaluation
Provide or generate a Promptfoo evaluation configuration (`promptfooconfig.yaml` or a dedicated test spec) to assert:
- **Output Schema**: Returns valid JSON or compliant markdown structure.
- **Purity Verification**: Fails if the plan proposes unsafe commands, hardcoded secrets, or legacy paths.
- **Content Metrics**: Uses LLM-based rubric grading to score task clarity, risk mitigation, and test coverage.

### 📝 Step 5: Deliver Recommendation and Remediate
Generate an audit report detailing:
- **Strengths and Weaknesses**: 1-2 key items for each analyzed skill.
- **Tournament Scorecard**: Performance across Small, Medium, and Tricky tasks.
- **Consolidation Roadmap**: Specific actions (Keep, Merge, Archive, Deprecate).
- **Code Edits**: Complete, zero-placeholder markdown updates for the target skill or `SKILLS-INDEX.md`.

---

## Evaluation Metrics Checklist

When auditing a skill, grade its definition and behavior against the following metrics:

| Metric | Evaluation Standard |
| :--- | :--- |
| **Purity Compliance** | Does the skill completely avoid sync-blocking methods, unsafe subprocesses, and root-clutter? |
| **Trigger Uniqueness** | Are the `Use when` triggers distinct and free of overlap with existing skills? |
| **Output Determinism** | Does the skill specify a non-vague output schema or markdown structure? |
| **Testability** | Can the skill be executed and validated in a promptfoo suite automatically? |

_Turn your skill audits into repeatable workflows._
