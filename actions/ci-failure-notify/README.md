# Concise CI failure notification

Use this action from a repository-owned `workflow_run` workflow when a failed CI
run should produce one bounded notification. It does not poll CI, retry failed
builds, inspect repository secrets, or launch a coding agent.

The consuming repository owns the destination and secret. Pass the webhook URL
from its secret store and pin the action to an immutable `agent-platform`
commit or release.

Example caller:

```yaml
name: CI failure notification
on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]

permissions: {}

jobs:
  notify:
    if: github.event.workflow_run.conclusion == 'failure'
    runs-on: ubuntu-24.04
    steps:
      - uses: arbitraged-life/agent-platform/actions/ci-failure-notify@PINNED_COMMIT
        with:
          repository: ${{ github.repository }}
          workflow: ${{ github.event.workflow_run.name }}
          conclusion: ${{ github.event.workflow_run.conclusion }}
          run-url: ${{ github.event.workflow_run.html_url }}
          sha: ${{ github.event.workflow_run.head_sha }}
          webhook-url: ${{ secrets.CI_FAILURE_WEBHOOK_URL }}
```

The output intentionally stays concise: repository, workflow, tested SHA, and
the canonical run URL. Rich diagnosis belongs in the CI system or a later
explicit remediation workflow.
