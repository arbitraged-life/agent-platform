# ChatGPT host adapter

Apply [the shared router](../SKILL.md) first. This reference maps its decisions
to ChatGPT host surfaces; it is not a second routing policy, a connector grant,
or a record that any particular app is installed. Chat/Work selection is
platform-managed: do not ask the user to switch modes or invent a switching
tool. ChatGPT and CLI/coding agents are peer surfaces, not authority owners.

## Direct actions and host-required delegation

In an ordinary ChatGPT session, an owning connected app is an `owner-tool`
route for its authorized cloud actions. An authorized Desktop Commander
connection can be `direct-local` for filesystem, shell, Git, process, build,
test, lint, Docker, and runtime work **when the current host permits direct
access to that selected device**. Discover the actual connector and its tools
rather than assuming availability. GitHub's remote contents API cannot safely
replace a filter-aware checkout for encrypted Git paths; inspect the repository
attributes and policy before any write.

A dot coordinating in the cloud must use a host-supported delegated task for
work on the user's computer, registered remote, or saved coding environment
when the host requires that boundary. Do not operate those environments
through a direct connector in that case. Inspect the available environment
catalog and selected route's connection and authorization requirements. Honor
the user's selected environment; a blocked or offline executor is not license
to substitute a different environment or direct tool. Keep the dot's own cloud
computer distinct from the selected user/saved executor. Use the host's actual
task schema and approval flow, retain the resulting task ID, and verify the
result in the owning system. This host task is **not** a local-launcher packet.
See the public [dot computer-access guide](https://help.openai.com/en/articles/20001530-getting-started-with-your-dot)
for the separate-task model. A connected coding-agent service such as BB is
another `delegated-agent` path only when independently permitted by the host
and authorized for the originating task.

## Desktop Commander transport

Read the consuming installation's trusted transport policy if more than one
authorized Desktop Commander connection reaches local execution. Follow its
configured preferred/fallback order **after** choosing `direct-local`; the
router does not encode a vendor- or machine-specific transport order. Confirm
the target device independently for the selected connection. Different devices
can expose different filesystems, sandboxes and permissions; fallback to a
second device is a new operation requiring explicit authorization, never a
retry. For an ambiguous mutation, establish that the original invocation has
terminated or obtain idempotency/status evidence proving safe replay, then
read authoritative state on the **same device** before retrying. Never use
transport fallback to bypass denied commands, filesystem boundaries, or
approval requirements.

## Host-specific observability

The originating ChatGPT run may be a parent identifier **only when** the
consuming installation has configured that trace destination. Link local task
metadata without claiming access to hidden agent internals. Existing
application analytics or spreadsheets retain their own configured ownership;
no ChatGPT conversation or connected-tool call is automatically a production
trace. Never upload raw prompts, logs, credentials or unrelated personal data
by default. Keep source publication, plugin installation and native ChatGPT
Project instructions as separate rollout states.
