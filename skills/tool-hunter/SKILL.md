---
name: tool-hunter
description: Discover and shortlist applied AI tools, products, and GitHub repos that solve a given software engineering or productivity problem.
---

# Tool hunter skill

## When to use this skill

Use this skill when the user expresses a problem or desire such as:

- "We need better AI evals."
- "We want GitHub-native agents."
- "I need an AI tool to speed up PR review/testing/documentation."
- "What tools exist for LLM observability, logging, or monitoring?"

The core job is to translate these vague needs into concrete search queries, then find and summarize relevant tools, repos, and products.

## Inputs

From the user request, extract:

- Problem statement: What workflow or pain-point they want to improve.
- Context: Tech stack (languages, frameworks), hosting constraints (SaaS vs self-hosted), security/enterprise constraints if mentioned.
- Preferences: Open source vs SaaS, budget sensitivity, preferred ecosystems (GitHub, Slack, VS Code, etc.), if provided.

If any of these are missing, infer reasonable defaults for a senior engineer, but do not invent hard requirements.

## Outputs

Produce:

- A concise list (or table) of candidate tools and repos.
- For each item:
  - Name and link.
  - One-line purpose summary.
  - Category (e.g., “agent framework”, “AI code review”, “RAG framework”, “LLM observability”, “workflow automation”, “productivity app with API”).
  - Hosting model (SaaS / self-hosted / both).
  - License for open-source repos, if known.
  - One or two key strengths and one main trade-off or limitation.

## Instructions

1. Understand the problem
   - Rewrite the user’s need in your own words as a short “Problem” line to keep the search focused.
   - Identify whether this is primarily about:
     - Software engineering workflow,
     - AI/LLM-specific workflow (agents, evals, monitoring),
     - Personal/team productivity with a developer/API angle.

2. Plan the search
   - Derive 3–6 targeted queries combining:
     - The problem domain (e.g., “LLM evaluation”, “GitHub PR review”, “RAG observability”).
     - Tool type keywords (e.g., “framework”, “open source”, “SaaS”, “GitHub repo”, “awesome list”).
   - Prioritize:
     - Official product sites,
     - GitHub repos,
     - Curated directories and “awesome” lists.

3. Discover candidates
   - Use multiple sources:
     - Web search for products and blog roundups.
     - GitHub search and curated “awesome” lists for repos.
   - Prefer:
     - Actively maintained, well-documented projects.
     - Tools with clear positioning, docs, and examples.

4. Filter aggressively
   - Exclude:
     - Obvious toys or non-technical apps with no API/integration story.
     - Abandoned repos (no meaningful activity in a long time) unless historically important.
   - Favor:
     - Tools that can reasonably be adopted by a senior engineer or small team.
     - Solutions that fit typical Python/TypeScript/DevOps stacks and cloud environments.

5. Normalize results
   - Consolidate the final short list into a compact Markdown table with:
     - Name and link,
     - Category,
     - Hosting (SaaS/self-hosted/both),
     - License (if open source),
     - Key strengths,
     - Main caveat/trade-off.

6. Make the list scannable
   - Lead with a 1–2 sentence TL;DR summarizing what categories and top tools you found.
   - Keep each tool’s description tight and implementation-oriented.
   - Avoid marketing fluff; highlight what an engineer can *actually do* with the tool.

7. Be honest about gaps
   - If hosting model, license, or certain features are unclear, say so explicitly.
   - Suggest specific next steps for verification (e.g., “Check the LICENSE file in the repo” or “See the Pricing/Docs page for deployment options”).
