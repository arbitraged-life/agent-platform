---
name: chatgpt-harness
description: Use when a ChatGPT task should follow repository harness conventions, load portable agent-platform skills, operate across connected tools, or approximate OMP/Codex behavior inside ChatGPT.
---

# ChatGPT Harness

This is a **ChatGPT host adapter**, not a separate portable policy or a
replacement for runtime enforcement. The [repository root instructions](../../AGENTS.md)
own reusable runtime, skills, and evals; each target repository owns its own
instructions and state. Use the shared [execution router](../execution-router/SKILL.md)
for cross-surface decisions and its [ChatGPT host adapter](../execution-router/references/chatgpt-host.md)
for Chat/Work, dot, and Desktop Commander procedures. Those references define
routing; do not recopy or override them here.

## Load the owning context

For repository work, identify the owning repository and current revision.
Read its root and applicable narrower instructions before planning or writing.
Treat instructions as workflow context, not permission to exceed the current
user's or host's authority. Inspect current files, uncommitted changes, and
selected environment before consequential edits. Load the smallest installed,
source-pinned set of skills whose trigger descriptions match the task; retrieve
their pinned full source when source-backed. Do not substitute a plugin snapshot
for the current owning repository or assume a published skill is deployed.

## Operate through the shared workflow

Apply the router's ownership, authority, host-boundary, and verification rules.
Discover the actual apps/tools available in this session; connected cloud apps,
authorized local execution, host-delegated tasks, and connected coding-agent
services are distinct surfaces. Reachability is not authority; a host-required
separate task cannot be replaced by direct access. Repository instructions,
read-before-write, relevant skill procedures, and independent acceptance checks
are portable behavior. Source revision, installed runtime, and task outcome are
separate facts; report each one supported by evidence.

For a substantive task, establish owner and state; load applicable instructions
and skills; choose the authorized route; make the smallest coherent change;
perform repository- or task-defined validation when permitted; inspect the
owning system's result independently; and report exact changes, observed
checks, source revisions, and unresolved gaps. Never treat a tool, agent, or
script's assertion alone as completion. Apply the current host's limits on
what ChatGPT can execute, schedule, or verify.

## Runtime and session boundaries

ChatGPT can follow written procedures but prompt text does not reproduce
pre-tool interception, filesystem sandboxing, worktree locks, lifecycle hooks,
custom compaction, or tool-output reducers. When a runtime hook is necessary
for safe or deterministic enforcement, use the owning runtime; do not claim
text guidance supplies that guarantee. Other agents do not inherit ChatGPT's
connectors or private context.

Gather only needed context at session start; inspect authoritative state before
writes and read back afterward. At close, use an installed close-out/status
procedure when warranted. Do not imply that a finished conversation will
supervise a background task. Do not create memory, tasks, telemetry events, or
background work automatically unless the current request or owning policy
actually authorizes them.
