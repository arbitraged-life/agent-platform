---
name: evaluator-comparer
description: Normalize multiple AI tools and repos into comparable dimensions and present them as Markdown tables with clear 'choose this if…' guidance.
---

# Evaluator and comparer skill

## When to use this skill

Use this skill when the user wants to compare or choose between tools/repos, such as:
- "Which AI PR-review tool should we use?"
- "Compare LangChain vs LlamaIndex vs Haystack."
- "What’s the best option for LLM observability or evaluation in our stack?"

The job is to turn a set of options into a normalized, scannable comparison and give pragmatic recommendation guidance.

## Inputs

- A list of tools or repos to compare (from your own discovery or provided by the user).
- Any user constraints:
  - Self-hosted vs SaaS,
  - Language or framework preferences,
  - Budget/enterprise/security requirements,
  - Use case focus (code review, RAG search, agents, eval, monitoring, automation, etc.).

## Outputs

- One or more Markdown tables comparing the tools.
- For each tool:
  - Name and link.
  - Category/use case.
  - Hosting model (SaaS / self-hosted / both).
  - License (for OSS).
  - Ecosystem fit (e.g., “great with GitHub/VS Code”, “Kubernetes-first”, “cloud-agnostic”).
  - Complexity level (e.g., “low”, “moderate”, “high”) with a brief justification.
- A short “When to choose X vs Y” section with 2–4 bullets.

## Instructions

1. Identify comparison axes
   - From the user request and your tool analysis, choose 4–7 axes that matter most, such as:
     - Primary use case,
     - Hosting model,
     - License,
     - Ecosystem fit,
     - Integration complexity,
     - Maturity/maintenance,
     - Pricing posture (free/paid/enterprise).

2. Normalize data
   - For each tool, fill out each axis using consistent terminology and scale.
   - Avoid mixing qualitative scales for the same axis (e.g., don’t use “easy” for one and “medium” for another; choose “low/medium/high” or similar and stick to it).
   - If a value is unknown, mark it as “unclear” rather than guessing.

3. Build the table
   - Construct a Markdown table where:
     - Each row is a tool/repo.
     - Each column is a comparison axis.
   - Keep text in each cell short enough to scan quickly; expand details below the table if needed.

4. Provide decision guidance
   - After the table, include a concise “Recommendations” or “When to choose what” section.
   - Use bullets such as:
     - “Choose A if you want X and can accept Y trade-off.”
     - “Choose B if you prioritize self-hosting and Kubernetes integration.”
     - “Choose C for teams that want minimal setup and SaaS convenience.”

5. Reflect user constraints
   - Explicitly tie recommendations back to the user’s constraints:
     - Call out which options are incompatible (e.g., SaaS-only when self-hosting is required).
     - Highlight options that match the user’s stack or security posture.

6. Be transparent about trade-offs
   - For each recommended option, mention at least one trade-off (e.g., complexity, lock-in, pricing, weaker observability).
   - Avoid declaring a single “best” tool without context.

7. Keep it implementable
   - Ensure the comparison and recommendations help an engineer decide what to prototype next, not just understand differences.
   - Suggest a small shortlist (e.g., “Start with A and B in a spike; keep C as a fallback if X constraint arises.”) when appropriate.