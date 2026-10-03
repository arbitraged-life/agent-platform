---
name: repo-framework-analyst
description: Analyze GitHub repos and AI/LLM frameworks for maturity, integration complexity, and fit with typical TypeScript/Python/DevOps stacks.
---

# Repo and framework analyst skill

## When to use this skill

Use this skill when the user asks questions like:
- "Is this framework mature enough for production?"
- "How hard is it to integrate this repo into our stack?"
- "Which agent framework should I pick for a Python/TypeScript microservice environment?"
- "What’s the trade-off between these two or three GitHub projects?"

The job is to drill into repos/frameworks, interpret signals of maturity and complexity, and relate them to common engineering stacks and workflows.

## Inputs

For each candidate repo or framework:

- Repository URL or name.
- Any known constraints from the user:
  - Language requirements (Python/TypeScript, etc.).
  - Hosting model preferences (self-hosted vs SaaS).
  - Infra shape (containers, Kubernetes, serverless).
  - Security or compliance constraints, if specified.

## Outputs

For each repo/framework, produce:

- Name and link.
- One-line summary of purpose and main use cases.
- Implementation details: primary language(s), main runtime assumptions.
- Maturity signals:
  - Stars, recent commit activity, issue/PR activity patterns, contributor count.
- Integration complexity:
  - Dependencies, infra requirements, configuration surface.
  - How it fits into a typical CI/CD and deployment flow.
- Fit assessment:
  - How well it matches typical TypeScript/Python/DevOps practices.
  - Clear “good fit if…” and “not ideal if…” statements.

## Instructions

1. Read the high-level docs
   - Start with the README and top-level docs.
   - Identify:
     - Core problem the repo solves.
     - Primary scenarios (e.g., “agent orchestration”, “RAG toolkit”, “AI eval framework”, “observability layer”).
     - Supported runtimes and languages.

2. Inspect maturity signals
   - Look at:
     - Recent commit history and release cadence.
     - Number and recency of issues and PRs.
     - Number of contributors and maintainers.
   - Summarize these as qualitative signals (e.g., “active”, “slowing”, “stale”) rather than raw numbers.

3. Assess integration complexity
   - Identify key dependencies and integration points:
     - Required databases, queues, or external services.
     - Expected deployment model (single service, microservices, Kubernetes).
   - Note:
     - Whether quick-start examples or templates exist.
     - Whether there are Docker images or helm charts.
     - Any obvious vendor lock-in.

4. Map to common stacks
   - Relate the repo to typical setups:
     - Python/TypeScript backends,
     - CI/CD pipelines (GitHub Actions, GitLab, etc.),
     - Cloud-native infra (containers, Kubernetes, serverless).
   - Explain how an engineer would:
     - Add it to an existing monorepo or service,
     - Wire it into CI/CD,
     - Monitor and operate it in production.

5. Produce a structured summary
   - Output a compact Markdown block per repo with:
     - **What it is and does.**
     - **How mature it appears.**
     - **How hard it is to adopt.**
     - **When to choose it vs other options.**
   - Use bullets and short paragraphs to keep it skimmable.

6. Call out risks and unknowns
   - If documentation is thin, highlight it.
   - If support/community seem weak, say so.
   - Avoid guessing about capabilities; describe what is clearly documented or visible in the repo.

7. Compare when multiple repos are involved
   - If the user is choosing between several frameworks, provide:
     - A comparison table across key dimensions.
     - Plain-language guidance: “Choose A if you want X; choose B if you need Y.”