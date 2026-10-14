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
