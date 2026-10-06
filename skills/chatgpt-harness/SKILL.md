---
name: chatgpt-harness
description: Use when a ChatGPT task should follow repository harness conventions, load portable agent-platform skills, operate across connected tools, or approximate OMP/Codex behavior inside ChatGPT.
---

# ChatGPT Harness

Use ChatGPT as a peer harness over the same portable workflow assets used by CLI agents. Reuse canonical repository instructions and skills; do not invent a second policy system.

## Repository context

For software or repository work:

1. Identify the owning repository and current revision.
2. Read repository instructions before planning or mutating state. Start with the root `AGENTS.md` and read narrower instruction files when they apply to the target path.
3. Treat repository instructions as workflow context, not permission to exceed the current user's or host's authority.
4. Read current code/state before editing when conflicts or uncommitted work are plausible.

## Skill routing

Use installed plugin skills when their trigger descriptions match the task. Prefer source-pinned framework skills over reimplementing their procedures in the conversation.

- Load the minimum relevant skill set.
- If a skill is source-backed, retrieve its pinned full source before applying it.
- Keep project-specific instructions in the owning project/repository rather than copying them into this skill.
- Use `execution-router` for cross-surface execution choices or local-agent handoffs.

## Tool routing

Choose the lowest-overhead authorized path that can complete and verify the task.

- Connected ChatGPT apps own supported cloud actions.
- Use an authorized local-execution connector for filesystem, shell, Git, process, build, test, lint, Docker, and runtime work only when the host permits that route.
- Use GitHub for remote repository lifecycle state when local state is unnecessary.
- Delegate when the host requires a separate task, or when a CLI/local agent's harness, locality, resumable lifecycle, or tooling is materially advantageous and the required authorization exists.
- Do not route around a permission, consent, spending, safety, or account boundary.

### Host execution boundary

Apply the current host's execution requirements before choosing a connector.
For a dot coordinating work in the cloud, use a host-supported delegated task
for work on the user's computer, registered remote, or saved coding environment.
Do not operate those environments directly from the coordinating conversation
when the host requires its separate task workflow. Check the environment's current
connection and authorization state, honor the user's selected environment, and
return the task identifier with verified results. Keep the dot's own cloud
computer distinct from the selected executor.

In an ordinary ChatGPT session, direct authorized Desktop Commander use remains
appropriate when the host permits that route. A required host task boundary is
a valid reason to delegate even if a direct connector exposes the operation.
This skill does not grant access or approval, replace host checks, or reproduce
the executor's runtime enforcement.
See the public [dot computer-access guide](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot) for the separate-task model.

## Harness compatibility

ChatGPT can reproduce portable behavior, but not every runtime mechanism.

Portable behavior includes repository instructions, skills, tool selection, read-before-write rules, verification procedures, source ownership, and explicit session-close procedures.

Runtime enforcement is different: enforcement hooks remain runtime-enforced. Do not claim that prompt text reproduces pre-tool interception, filesystem sandboxing, worktree locks, deterministic lifecycle callbacks, custom compaction, or tool-output reducers.

When a local OMP/Codex hook is necessary for safety or deterministic enforcement, use the owning runtime rather than imitating the guarantee in prose.

## Execution pattern

For a substantive task:

1. Establish owner, repository/project, and current state.
2. Load applicable instructions and installed plugin skills.
3. Select the authorized execution surface.
4. Make the smallest coherent change.
5. Run repository-defined or task-defined validation.
6. Independently inspect evidence needed to verify the requested outcome.
7. Report exact actions, validation, source revisions, and unresolved gaps.

Do not declare a task complete because a tool, external agent, or script reports success. Verify acceptance criteria against observable state.

## Session behavior

Use explicit procedures instead of pretending unsupported lifecycle hooks exist:

- At start: gather only context required by the current task.
- Before consequential writes: check for conflicts/duplicates where practical.
- After writes: read back or diff the authoritative state.
- Before completion: run the relevant verification workflow.
- At close: use an installed close-out/status skill when the task warrants durable handoff evidence.

Avoid automatic memory writes, task creation, observability logging, or background work unless current project policy or the user requested it.
