---
name: workflow-designer
description: Design concrete AI-enhanced workflows and stack slices (e.g., LangGraph + Promptfoo + Helicone + Grafana) and map them to software engineering and productivity use cases.
---

# Workflow designer skill

## When to use this skill

Use this skill when the user asks:

- "How should I wire these tools together?"
- "What would an AI-assisted PR review / documentation / support workflow look like?"
- "How do I combine an agent framework, eval tool, and observability into one stack?"

The job is to propose realistic end-to-end workflows and stack slices that combine tools into something an engineering team can actually implement.

## Inputs

- Target use case (e.g., AI code review, test generation, documentation, support automation, RAG search, eval and monitoring).
- Known tools or preferences:
  - Preferred frameworks (e.g., LangChain/LangGraph, Dify, CrewAI, etc.).
  - Existing infra (GitHub, CI provider, observability stack).
  - Hosting and security constraints.
- Any non-functional requirements mentioned (latency, cost, auditability, data residency).

## Outputs

- One or more proposed workflows, each described as:
  - A stack slice (tool list) like “LangGraph + Promptfoo + Helicone + Grafana” or “Dify + n8n + Slack”.
  - A short narrative of how requests flow through the system.
  - Concrete integration steps or phases.
- Clear mapping from each tool in the stack to its role in the workflow.

## Instructions

1. Clarify the use case
   - Restate the user’s goal as a one-line “Workflow objective”.
   - Classify the workflow type (e.g., “PR review”, “support triage”, “internal knowledge retrieval”, “eval & red-teaming”, “developer productivity automation”).

2. Choose appropriate building blocks
   - From available tools/frameworks, select:
     - Orchestration / agent layer,
     - Evaluation / testing layer,
     - Observability / logging / monitoring,
     - Integration and automation (CI, webhooks, n8n/Pipedream-style tools),
     - User interface (CLI, chat, IDE, Slack, web UI).
   - Prefer combinations that are:
     - Technically compatible,
     - Maintainable by a small team,
     - Reasonable to prototype in days, not months.

3. Define the stack slice
   - Name the stack slice explicitly (e.g., “Agentic PR review pipeline”).
   - List tools with a brief role description, like:
     - “LangGraph – Agent orchestration and tool-calling.”
     - “Promptfoo – LLM evals and red-teaming for proposed workflows.”
     - “Helicone – LLM request logging and performance monitoring.”
     - “Grafana – Dashboarding for latency, error rates, and usage.”

4. Describe the end-to-end flow
   - Explain step-by-step how data and control move through the stack:
     - Where requests enter,
     - How tools/agents are invoked,
     - Where evals and monitoring happen,
     - What outputs go back to users or other systems.
   - Use numbered lists for clarity.

5. Provide implementation steps
   - Outline 5–10 concrete steps to build a minimal viable version of the workflow, for example:
     - “Set up the orchestration framework with a basic agent.”
     - “Wire in the LLM provider and logging.”
     - “Integrate with GitHub/Slack/CI via webhooks or APIs.”
     - “Add evaluation and monitoring.”
   - Call out any repo templates, quick-starts, or examples that can accelerate setup if you know them.

6. Suggest iterations and guardrails
   - Recommend how to harden the workflow over time:
     - Add evals, rate limiting, access control, audit logging.
     - Expand to more repositories/users/services once stable.
   - Note any security or compliance considerations for the design (e.g., PII, secrets, data residency).

7. Offer alternatives when appropriate
   - When there are clearly different stack shapes (e.g., “framework + à la carte tools” vs “all-in-one platform”), present 2–3 variants with:
     - Pros/cons for each,
     - Guidance: “Choose this variant if you value X over Y.”
