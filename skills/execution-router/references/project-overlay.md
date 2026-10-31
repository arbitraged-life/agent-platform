# Project instruction overlay v1

Preserve the project's existing domain, evidence, and permission rules. Add or
replace only the execution-routing section with this block:

Execution routing: Use the shared execution-router skill when a request requires
actions or a handoff. Treat Chat/Work routing as platform-managed. This project is
one brain in a broader execution mesh that can include ChatGPT, CLI coding agents,
and other local agents. Determine the owning system first, then choose the best
authorized execution surface allowed by the current host. Connected apps and
local-execution connectors are efficient direct paths only when the host permits
them. A dot uses the host-supported delegated task workflow for work on a user's
computer, registered remote, or saved coding environment. CLI/coding agents are
peer executors when their harness, locality, lifecycle, or tooling is materially
better suited. Handoff requires a host task boundary, concrete capability,
lifecycle, tooling/harness advantage, or explicit user preference, not complexity
alone. Prepare automatically. When a connected coding-agent MCP is the selected
authorized route, discover its actual tools and inspect the target environment
and existing work. Launch the bounded task directly when the originating request
or an approved profile already authorizes it; do not stop at a copy-paste prompt
or request the same approval again. Retain the provider's task identifier, inspect
status before retrying an ambiguous launch, and independently verify returned
artifacts. Use the provider's own lifecycle; do not invent a local-launcher
adapter or assume the local machine is available.

The configured local launcher requires actual per-task approval or a separately
approved profile; host-supported tasks use the host's own authorization flow.
Delegation never expands permissions, data access, or spending authority.
Preserve this project's scope. Require inspectable results and verify before
claiming completion. Read the selected executor's private deployment guidance;
do not invent paths, tools, accounts, or environments.

SEARCH remains research-only unless the current request explicitly authorizes a
bounded action. Future agents must state their purpose and authority separately;
this overlay does not grant the new agent access to every connected system.
