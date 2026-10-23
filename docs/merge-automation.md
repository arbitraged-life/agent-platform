# Merge automation

## Ownership

Renovate owns dependency discovery, eligibility, PR updates, and housekeeping.
For this public repository, it requests GitHub native squash auto-merge. GitHub
Free supports native auto-merge on public repositories. Mergify owns other PRs:
new owner-authored, same-repository PRs (number greater than **87**) are
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
| Low-risk stable minor/patch, pins/digests, lock maintenance | Automatic after required checks; npm updates also need mature release timestamps where supported. |
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

## Dependency supply-chain rules

Low-risk dependency updates keep GitHub-native automerge once the enforced
GitHub/CI protections are met. An additional **14-day minimum release age**
applies to the npm datasource, with a required registry timestamp and strict
internal check filtering. This intentionally delays newly published npm
versions and prevents an unverified timestamp from being treated as mature.
The existing three-day PyPI release-age preset remains in effect.

Even a patch, pin, or digest update is **review-only** when its dependency is
part of GitHub Actions, CircleCI, Terraform, Docker/Compose, Helm, Kubernetes,
devcontainers, custom regex-managed CLI pins, or the infrastructure/CI
file paths listed in `renovate.json`. Node and Python runtime versions are
review-only. Authentication, cryptography, cloud-control, and MCP SDK/package
updates likewise require manual review.

The restricted package rules follow the generic minor/patch automerge rules,
so they override the generic `automerge: true`. The restricted rules require
Dependency Dashboard approval before ordinary PR creation; vulnerability
alerts retain their existing immediate-PR exception and are never considered
approved merely because an alert or the `security` label exists. Apply
verified risk-based approval to those PRs explicitly.

A minimum age is not a malware guarantee: `pin`, lockfile maintenance, and
some digest updates do not carry enforceable publication timestamps. These
**npm-sourced pin, digest, and lockfile-maintenance updates are now review-only**,
rather than falsely claimed to satisfy the 14-day gate. Renovate uses npm's
age-aware resolution when supported, but an existing lockfile may require a
fallback; release-age gates do not replace diff review, immutable
action pinning, Qlty/security checks, or required CI. Do not change the
`platformAutomerge: true` executor for this public repository.

## Enforcement

`platformAutomerge: true` requires repository auto-merge enabled and real GitHub
required checks. The existing default-branch ruleset requires Mergify Merge
Protections from app 10562, requires up-to-date branches, prohibits force pushes,
and has no bypass actors. These settings are not relaxed.

The generic protection requires Linux and macOS validation, the GitHub secrets
job, Qlty, GitGuardian, Socket, no changes-requested reviews, and a Conventional
Commit title. These checks are not weakened by automatic queueing: if any
required check is absent, pending, or failing, Mergify cannot merge.
Mergify excludes Renovate from automatic queue entry, queue conditions,
conflict notifications, and stale-PR housekeeping.

## CI-green automatic queueing

`.mergify.yml` retains an explicit `merge-ready` route for PRs opened before
the cutover (including existing PR #85) or manually reviewed exceptions.
For new PRs, automatic queueing additionally requires the PR author to be
`arbitraged-life`, the head to be in this repository rather than a fork,
and PR number to be greater than 87. This prevents an unrelated contributor
or previously open PR from merging without deliberate selection.
No separate polling agent, duplicate merge executor, or paid CI lane is added.
This policy activates only after the configuration is merged to `main`;
merging the configuration PR itself follows the previous label-based gate.

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
