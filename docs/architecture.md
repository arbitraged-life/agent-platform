# Architecture and ownership

`agent-platform` publishes reusable runtime code, skills, evaluations, and
workflows. A consuming repository supplies its own policy, credentials, runner
ownership, and deployment targets. The public package has no dependency on a
consumer's private configuration.

```mermaid
flowchart LR
    subgraph Public["agent-platform · public source"]
        Runtime["runtime/ · reusable modules"]
        Skills["skills/ · portable skills"]
        Evals["evals/ · deterministic evaluations"]
        Workflows[".github/workflows/ · reusable workflows"]
        Validate["scripts/validate · local gates"]
        Build["platform-release.py build"]
        Runtime --> Validate
        Skills --> Validate
        Evals --> Validate
        Workflows --> Validate
        Validate --> Build
    end

    Build --> Artifact["Committed-source archive + commit/SHA-256 lock"]
    Artifact --> Install["Verify digest, manifest, paths, and commit; install atomically"]
    subgraph Consumer["Consuming repository · private ownership"]
        Policy["Policy, secrets, triggers, runners, and destinations"]
        Pin["Explicit release pin"]
        Install
        Active["Selected installed version"]
        Pin --> Install
        Policy --> Active
        Install --> Active
    end
```

Validation and release building are separate commands. The diagram shows the
intended release sequence: validate the committed source, build an immutable
archive and lock, then let a consumer verify and select a version. Installing
a release does not activate a service or change a consumer's configuration.

See the [release contract](release-contract.md) for the exact artifact checks and
the [execution router](execution-router.md) for one reusable runtime interface.

## Security trust boundaries

The generated [runtime import map](generated/runtime-map.md) shows source
dependencies, not security guarantees. These behavioral boundaries are
reviewed separately; private authorization and deployed runtime state remain
owned by each consuming repository.

```mermaid
flowchart TB
    subgraph UNTRUSTED["Untrusted inputs — no inherited authority"]
        PR["PR source, diffs, review comments"]
        SK["Third-party skill/reference content"]
    end
    subgraph PUBLIC["agent-platform — reusable validation"]
        Review["review engine + feedback validation"]
        Sandbox["bounded remediation executor + offline verifier"]
        Router["execution-router: approved packet + workspace fingerprint"]
        Release["immutable source archive + SHA-256 release verifier"]
        Observability["schema-restricted telemetry events"]
    end
    subgraph PRIVATE["Consumer-owned identities and permissions"]
        Policy["Trusted policy, allowlists, approval and release lock"]
        Agent["Authorized local agent sandbox / container"]
        Publisher["GitHub App / PR publisher + exact-head checks"]
        Destination["Selected installed version and provider endpoints"]
    end
    PR -->|bounded parsed evidence| Review
    PR -->|read-only archive| Sandbox
    SK -.->|untrusted reference only| Policy
    Policy -->|capability and task-specific authorization| Router
    Router -->|bounded approved execution| Agent
    Sandbox -->|verified changes, never raw reviewer commands| Publisher
    Review -->|advisory output, not approval| Publisher
    Policy -->|trusted release pin| Release
    Release -->|digest + installed-byte readback| Destination
    Agent -->|metadata-only event| Observability
    Observability -->|authorized exporter| Destination
    Policy -->|credential scope, branch and check policy| Publisher
```

Boundaries not implied by this diagram:

- The review agent receives untrusted source and feedback **without** GitHub
  publication credentials. A separate verifier and exact-head publication
  conditions remain necessary; an AI review does not approve or merge a PR.
- The execution router binds approval to a specific executable, worktree and
  source snapshot. A workspace profile is not full OS-level read confinement;
  host sandbox, MCP permissions, outbound model traffic and authorizations
  remain independent.
- A release lock authenticates a known bundle only when its source/digest is
  trusted. `platform-release.py verify` checks bundle and installed bytes but
  does not select an active runtime or establish deployed behavior.
- The telemetry contract accepts structured event metadata, not raw prompts,
  tool arguments, local file paths or credentials. Downstream exporter
  authorization and confirmation of ingestion remain separate.
- Source and generated architecture changes never enable an MCP server,
  modify consumer policies, grant a token, bypass a CI gate or deploy a service.
