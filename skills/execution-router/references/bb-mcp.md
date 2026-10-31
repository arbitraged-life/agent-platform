# BB through MCP

Use BB's existing MCP server for a selected, authorized coding-agent task.
This procedure does not install the server or attest that a connection is ready.
Confirm the installed tool schemas and CLI help before a mutation.

## Connection and authority

The official plugin is `bb--mcp`. `bb mcp status --json` reports its local
and BB Connect remote addresses. Connection, account approval, project IDs,
machines, providers and deployment preferences belong to the consuming
installation. Use its existing authorized connection; do not create a second
gateway or weaken a profile to reach BB.

BB's OAuth grant permits control of the entire BB instance. Its `read` tool is
an inspection allowlist, not a separate OAuth permission. The JavaScript snippet
sandbox does not sandbox the agents or terminals started through BB. Preserve
the originating task's authority, provider limits and any pending permission
interaction. A remote BB Connect URL does not prove the server or execution
machine is online or move execution into the cloud.

## Discover and inspect

BB exposes three tools: `search({query, limit?})`, `read({code})`, and
`run({code})`. Use `search` to obtain commands and options from the actual
instance. Snippets call `bb.cli(argv, {stdin})` or `bb.json(argv, {stdin})`;
`bb.json` adds JSON output and throws on command failure.

Through `read`, inspect the selected project, environment, machine, provider
and relevant threads. The current CLI supports `project list/show`,
`machine list`, `environment list/show`, `provider list/models` and
`thread list --project ID`. Inspect configuration and resolve the repository,
revision and dirty/active work before launching. Reuse a matching task when
appropriate. Missing fields are unknown, not proof of a safe default.

Choose an existing approved environment or an authorized isolated worktree.
An existing environment determines its machine. For a new worktree, confirm the
installed `--machine`, `--new-environment worktree` and `--base-branch`
options. Creating another machine, changing permission modes or selecting
another billed provider requires its own authority. Preserve suitable verified
defaults rather than overriding them for convenience.

## Launch a bounded task

Include a unique correlation ID, origin, objective, repository/revision,
permitted actions, acceptance criteria, relevant findings, limits and stop
conditions in the handoff. Send only needed task context; never credentials or
whole conversation history.

Invoke `run` once with the discovered command. With verified project and
environment IDs, the current form is:

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

The reviewed spawn command has no idempotency key. If creation times out or its
result is ambiguous, inspect recent project threads for the correlation ID and
matching scope before another launch. Preserve uncertainty when no conclusive
readback is available.

## Continue, stop and verify

| Need | Current CLI operation through MCP |
| --- | --- |
| State | `read`: `thread show ID` |
| Result | `read`: `thread output ID` |
| Bounded history | `read`: `thread log ID --limit N` |
| Questions or permission requests | `read`: `thread interactions list ID`, then discovered show command |
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

Upstream source describes supported behavior; live discovery establishes the
commands and capabilities available to this installation.
