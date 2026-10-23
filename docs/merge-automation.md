# Merge automation

## Ownership

Renovate owns dependency discovery, eligibility, PR updates, and housekeeping.
For this public repository, it requests GitHub native squash auto-merge. GitHub
Free supports native auto-merge on public repositories. Mergify owns other PRs:
new owner-authored, same-repository PRs (number greater than **86**) are
automatically queued when the existing Merge Protections and CI checks pass.
Older PRs and external contributions require the existing `merge-ready` label.
Renovate remains excluded from Mergify's queue and continues using GitHub
native auto-merge under its narrower dependency eligibility rules.

The repository-local `renovate.json` extends official Renovate presets directly.
The reusable `default.json` remains unchanged, so consuming repositories do not
inherit this repository's merge-executor change.

## Eligibility

| Update | Decision |
| --- | --- |
| Stable minor/patch, pins/digests, lock maintenance | Automatic after enforced checks. |
| Major application/service updates | Review migration impact, test it, then select that PR. |
| Pre-1.0 versions | Review-only; an exception needs package-specific build/smoke evidence. |
| Security updates | Same version-specific policy; security labels are not approval. |

Development dependencies follow the same update-type rules: stable minor/patch
updates are eligible, but being a development dependency never exempts a major
or pre-1.0 version upgrade from review. Pins/digests and lock maintenance retain
their separately approved policy; they are not blanket version-upgrade approval. An
approved exceptional update may be completed automatically after its own gates;
this does not approve every future version. Existing release-age safeguards,
schedules, limits, action/digest pinning, and infrastructure grouping remain.

## Enforcement

`platformAutomerge: true` requires repository auto-merge enabled and real GitHub
required checks. The existing default-branch ruleset requires Mergify Merge
Protections from app 10562, requires up-to-date branches, prohibits force pushes,
and has no bypass actors. These settings are not relaxed.

The generic protection requires Linux and macOS validation, the GitHub secrets
job, Qlty, GitGuardian, Socket, no changes-requested reviews, and a Conventional
Commit title. Mergify excludes Renovate from automatic queue entry, queue
conditions, conflict notifications, and stale-PR housekeeping.

GitHub waits for required checks, not every optional installed integration.
Additional blocking findings must be investigated before selecting an exceptional
PR. Do not turn optional scan failures into synthetic passing statuses.

## Verification

Run `python3 -m unittest discover -s tests -p test_merge_policy.py` and
`./scripts/validate`, then validate Renovate and Mergify configuration.
Verify configuration on main, the live required-check ruleset, and a native
auto-merge request separately from observing an actual autonomous merge.

References: [GitHub auto-merge](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/automatically-merging-a-pull-request),
[Renovate platform automerge](https://docs.renovatebot.com/configuration-options/#platformautomerge).
