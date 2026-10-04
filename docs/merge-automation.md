# Merge automation

Mergify is the merge authority for `agent-platform`.

## Policy

- Merge Protections gate merges into `main` on deterministic CI, GitGuardian,
  Socket PR scanning, and the absence of outstanding change-request reviews.
- Safe Renovate updates receive `renovate-automerge`; security updates remain manual.
- Renovate is the sole dependency-maintenance producer. The shared preset ignores archival/runtime-copy trees, applies Renovate's official three-day PyPI release-age safeguard, performs weekly lock-file maintenance, pins digests/actions, and tracks pinned Mergify CLI releases used by Test Insights.
- Human-authored pull requests opt into automation with the `merge-ready` label.
- Auto-Merge sends eligible pull requests to the Merge Queue.
- The Merge Queue uses serial, single-PR squash merges with single-step in-place
  checks, preserving compatibility with GitHub's strict up-to-date required-status policy.
- Workflow Automation is limited to non-merge housekeeping; currently it comments
  when a pull request has a merge conflict.
- Security fixes have high queue priority; routine Renovate updates have low priority.

The fallback operator command is `@Mergifyio queue` when a pull request should be
queued manually.

## Failure behavior

A failed required check or merge conflict leaves the pull request unmerged. Workflow
Automation may comment on conflicts, but only Merge Protections plus the Merge Queue
authorize an automated merge.


## Renovate ownership

Renovate is the only dependency pull-request producer for the active platform
repositories. The shared `default.json` preset uses Renovate
`config:best-practices`, which already supplies weekly lock-file maintenance,
Docker digest pinning, GitHub Action SHA pinning, configuration migrations,
development-dependency pinning, abandoned-package detection, and the npm
minimum-release-age safeguard.

To reduce PR noise without coupling unrelated application upgrades, the shared
policy groups only low-coupling infrastructure families:

- GitHub Actions minor/patch/pin/digest updates
- Terraform provider minor/patch/pin/digest updates
- CircleCI minor/patch/pin/digest updates

Application/runtime package updates remain independently reviewable. Multiple
major releases are separated into sequential major upgrades.

Renovate also owns pinned command-line dependencies embedded outside ordinary
package manifests. Shared regex managers detect `npx --yes package@x.y.z` pins
and `uv --with Package==x.y.z` pins in justfiles, shell scripts, and YAML. This
keeps eval/tooling pins such as Promptfoo and ad-hoc Python helpers on the same
managed update path instead of requiring custom bump scripts.

Renovate never merges directly; it labels eligible stable updates and Mergify
remains the sole automated merge authority.
