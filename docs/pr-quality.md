# Pull-request quality controls

The public platform provides reusable **mechanical** controls for repositories
that use coding agents. Repository-specific people, team names, ticket formats,
and proprietary examples belong in the consuming repository or work-local
knowledge layer.

## Controls

| Concern | Reusable asset | Boundary |
| --- | --- | --- |
| CI failure signal | `actions/ci-failure-notify/` | One failure event → one concise HTTPS webhook; no polling or remediation |
| Reviewer ownership | `examples/pr-quality/CODEOWNERS` + `scripts/pr/validate_codeowners.py` | Real handles must come from the target repo/team |
| PR structure | `examples/pr-quality/PULL_REQUEST_TEMPLATE.md` + `scripts/pr/validate_pr_contract.py` | Validator checks structure/evidence presence, not whether semantic Why/What claims are true |
| Code-generation budgets | `scripts/quality/codegen_budget.py` + example config | Hard size budgets fail; comment/test ratios are advisory by default |
| Team style | `repo-style-miner` skill | Mine accepted target-repo PRs/review feedback; never invent or publish proprietary examples here |

## Intended work-repository rollout

1. Resolve real CODEOWNERS handles and path boundaries from the work repository.
2. Copy/adapt the deterministic PR template and contract.
3. Pick conservative code-generation budgets from recent accepted PRs, then
   tighten only after measuring false positives.
4. Wire the CI failure action to an already-approved repository/team webhook.
5. Run `repo-style-miner` against 20–40 accepted team PRs and reviewer feedback,
   keeping the resulting style skill in the authorized work-local/repository
   surface.
6. Validate on a holdout set before making any rule merge-blocking.

Do not use public `agent-platform` as a store for employer-specific reviewer
identities, PR excerpts, code samples, or internal URLs.
