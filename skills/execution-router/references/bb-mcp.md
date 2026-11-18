# BB through MCP

Use BB's existing MCP server for a selected, authorized coding-agent task.
This procedure does not install the server or attest that a connection is ready.
Confirm the installed tool schemas and CLI help before a mutation.

## Connection and authority

The official plugin is `bb--mcp`. `bb mcp status --json` reports its local
and BB Connect remote addresses. Connection, account approval, project IDs,
machines, providers, deployment preferences and approval evidence belong to
the consuming deployment's private operational state, never this public
reference or public runtime files. Use its existing authorized connection;
do not create a second gateway or weaken a profile to reach BB.

BB's OAuth grant permits control of the entire BB instance, not task-specific
approval. Its `read` tool is an inspection allowlist, not a separate OAuth
permission. The JavaScript snippet sandbox does not sandbox agents or terminals
started through BB. Confirm authorization for this BB instance/account,
selected project/repository, environment, machine, provider, permission mode,
task scope, data boundary and material cost. Local-launcher approval does not
transfer. Preserve any pending permission interaction as a separate decision.
A remote BB Connect URL does not prove the server or execution machine is
online or move execution into the cloud.

## Discover and inspect

BB exposes three tools: `search({query, limit?})`, `read({code})`, and
`run({code})`. Use `search` to obtain commands and options from the actual
instance. In `read`, `bb.json(["guide", "commands", "thread"])` returns
`{chapter, commands}` with each command's path, arguments and options;
`bb.cli(["thread", "list", "--help"])` and
`bb.cli(["thread", "interactions", "show", "--help"])` give read-only CLI
help. Confirm the relevant command and options against those outputs before
using them. Snippets call `bb.cli(argv, {stdin})` or
`bb.json(argv, {stdin})`; `bb.json` adds JSON output and throws on failure.

Through `read`, inspect the selected project, environment, machine, provider
and relevant threads. The reviewed CLI supports `project list/show`,
`machine list`, `environment list/show`, `provider list/models` and
`thread list --project ID --json`. Confirm these through live `search` and
read-only help. Inspect configuration and resolve repository, revision, dirty
and active work before launch. Missing fields are unknown, not safe defaults.

Choose an existing approved environment or an authorized isolated worktree.
An existing environment determines its machine. For a new worktree, confirm
the installed `--machine`, `--new-environment worktree` and `--base-branch`
options. Creating another machine, changing permission modes or selecting
another billed provider requires its own authority. Preserve suitable verified
defaults rather than overriding them for convenience.

## Launch a bounded task

Include a unique correlation ID in the thread title and handoff; include
origin, objective, repository/revision, permitted actions, acceptance criteria,
relevant findings, limits and stop conditions. Send only needed task context;
never credentials or whole conversation history.

BB `thread spawn` has no atomic idempotency key. **Before** using `run`, require
an actual existing exclusive owner or atomic reservation shared by all
controllers capable of launching this correlation ID. Hold ownership through
the creation and uncertain-result reconciliation. BB `thread list` followed by
`thread spawn` is not an atomic reservation; neither this guide nor MCP creates
one. If exclusive ownership cannot be established, stop and report the blocker.
Under that owner, use `read` to check for matching existing work and reuse it
when appropriate.

Invoke `run` once with the discovered command only after authorization and
exclusive ownership are established. With verified project and environment
IDs, the reviewed form is:

```javascript
return await bb.json(
  ["thread", "spawn",
   "--project", projectId,
   "--environment", environmentId,
   "--title", correlationTitle,
   "--prompt-file", "-"],
  {stdin: handoff}
);
```

The identifiers and handoff above are values populated from inspection, not
literal placeholder arguments. Use `--provider` or `--model` only for an
authorized, verified selection. Record the returned thread and environment IDs
and any actual URL. External ChatGPT has no BB parent thread: MCP clears
`BB_THREAD_ID` and related context, so do not use `--parent-self` or invent
a parent ID.

If creation times out or its result is ambiguous, retain the exclusive owner.
First confirm via live `search` and read-only CLI help that `thread list
--project ID --json` returns an untruncated array with `title`, `id`,
`projectId`, and `environmentId`, and determine whether hidden and archived
threads are included. Run it through `read`, including `--include-hidden` and
a separate `--archived` read when required by that installation; match the
**exact correlation ID in `title`**, then use `thread show ID` to confirm
project, environment and scope before resuming the matching task. The reviewed
CLI exposes `title` in JSON, but a live truncated, stale or incomplete listing
does not prove absence. If the result remains uncertain, **do not retry**;
preserve the owner and report an unresolved launch until authoritative
readback establishes what happened. Never infer safe replay from an empty list.

## Continue, stop and verify

| Need | Current CLI operation through MCP |
| --- | --- |
| State | `read`: `thread show ID` |
| Result | `read`: `thread output ID` |
| Bounded history | `read`: `thread log ID --limit N` |
| Questions or permission requests | `read`: `thread interactions list ID`, then `thread interactions show INTERACTION_ID ID` for the selected interaction; confirm both via live `search` and read-only help before use |
| Steer active work or start a follow-up turn | `run`: `thread tell ID --mode auto --message-file -`, with stdin |
| Stop this task | `run`: `thread stop ID` |

Answer task questions from existing evidence when authorized. A separate
permission interaction is not automatically approved by possession of `run`.
Do not grant broader access or bypass a denial through another executor.

Snippets have a 25-second wall deadline. Prefer state reads; if waiting is
useful, use a short supported wait such as `thread wait ID --timeout 15s`
through `bb.cli`, which preserves the nonzero timeout result. A wait timeout
is not launch failure and does not justify a new thread.

BB states include pending, starting, active, stopping, idle and error.
`idle` can mean finished, paused or awaiting input. Read output and interactions,
then independently inspect the owning repository's changes, exact revision,
tests and requested publication state. Distinguish submitted, running, returned,
blocked and verified completion. An agent's claim or green exit code is not
acceptance. Return the real thread ID and last observed state if work outlives
the conversation; do not imply an unattended ChatGPT watcher.

## Source baseline

Reviewed against official BB source at
`916d684ac23d0b0de82c09cfc7553a50287d2188` (2026-10-31):

- [MCP guide](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/plugins/mcp/skills/mcp/SKILL.md)
- [Tool schemas](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/plugins/mcp/src/mcp-handler.ts)
- [Thread creation](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/apps/cli/src/commands/thread/spawn.ts)
- [Thread list and JSON readback](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/apps/cli/src/commands/thread/list.ts)
- [Interaction inspection](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/apps/cli/src/commands/thread/interactions.ts)
- [Read-only guide command index](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/apps/cli/src/commands/guide.ts)
- [MCP read-only command policy](https://github.com/get-bb/bb/blob/916d684ac23d0b0de82c09cfc7553a50287d2188/plugins/mcp/src/policy.ts)

Upstream source describes supported behavior; live discovery establishes the
commands and capabilities available to this installation.
