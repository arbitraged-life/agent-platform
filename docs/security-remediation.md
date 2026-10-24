# Dependency vulnerability remediation

`agent-platform` owns reusable code and the two npm lockfiles. The private
consumer owns deployment, credentials, approvals and merging policy.

## Existing-source automation

1. GitHub/Socket/GitGuardian/Sonar surface findings within their own scopes.
   Renovate's `vulnerabilityAlerts` opens **security-labelled PRs** immediately,
   independently of the ordinary Monday update schedule. Renovate's GitHub
   Actions manager already tracks `setup-node` and `setup-python` version
   inputs; patch releases for those interpreters use an immediate, review-only
   fast lane rather than waiting for the general Monday update schedule.
   No duplicate dependency updater or custom version parser is needed.
2. `scripts/audit_dependencies.py` requests registry advisories for **both**
   npm lockfiles, including development packages, without installing software.
   High/critical advisories, missing lockfiles, malformed responses, and
   unavailable registry evidence fail closed. `scripts/validate ci` and
   `scripts/validate security` invoke this check. The existing weekday Test
   Insights scheduled run invokes the same helper, even if Mergify's optional
   JUnit-upload credential is missing.
3. Existing CI, unit tests, release-boundary checks, external security scanners,
   and merge protections verify proposed updates. A version bump alone is
   not proof of remediation.
4. Dependabot security updates and Renovate overlap. Retain Renovate as the
   single version-update owner here; inspect account settings before enabling
   a second mutating dependency-update service.
5. Renovate owns GitHub **native auto-merge** only for updates that remain
   eligible under every matching package rule (for example safe stable
   minor/patch updates after enforced checks). npm, infrastructure, sensitive
   packages and lockfile maintenance have later review-only overrides.
   Mergify excludes `renovate[bot]` from its own queue to prevent competing
   merge writers; this is **not** a ban on GitHub-native auto-merge. Major,
   pre-1.0, and interpreter security-toolchain patch PRs remain review-only.
   The additive `renovate-automerge` label does not override an explicit
   `automerge: false` or dependency-dashboard approval requirement. A security
   label alone never approves an otherwise ineligible change.

## Nested Worker advisory exception (October 2026)

`skills/turnstile-spin/templates/worker` pins an `undici` override to
`7.30.1` because the transitive Miniflare release required vulnerable
`7.29.1`. This blocks CVE-2026-109869 / GHSA-xjj6-f33q-929c; the nested
lockfile was re-resolved, `npm audit` found zero advisories, Worker unit tests
passed, and its TypeScript typecheck passed. Review and remove the temporary
override when Miniflare's normal dependency graph uses a patched version.
The audit explicitly includes devDependencies under `NODE_ENV=production`;
malformed registry responses and absent evidence fail closed.

## Limits and escalation

The npm helper audits only the two declared npm lockfiles. It is **not** an
image, installed Node/Python interpreter, Python-package, GitHub Actions, IaC,
cloud-provider or unpublished CVE scanner. These surfaces require their own
provider inventories and vulnerability feeds. The runtime selected by each
consumer must be read back independently.

For source-code findings, prefer vendor-provided deterministic autofixes or
CodeQL/Copilot Autofix suggestions where available. Do not treat the existence
of an advisory, fix suggestion, or bot label as verified installation or safe
publication. A coding agent may be used for a *bounded* unresolved fix under
the existing review-remediation contract: exact trusted finding, restricted
paths, limited attempts, offline verification, independently approved PR
publication, and no inferred merge/deploy authorization. Do not build another
agent queue or scheduler in `agent-platform`.

Permissions, sandbox configuration, credentials, CI protections, major-version
changes, provider accounts and runtime deployments remain human-reviewed.
Denials are terminal for the attempted operation. The consuming project's
existing maintenance owner handles residual drift; no new agent is scheduled.

## Acceptance and readback

Run the read-only advisory check:

```sh
python3 scripts/audit_dependencies.py
```

Run all existing checks and the explicit local advisory/security gate:

```sh
./scripts/validate
./scripts/validate security
```

A security PR should identify affected CVEs/advisories, exact dependency and
interpreter versions, test results, remaining deployment exposure, and blocked
consumer operations. Merged source is not an installed update. Consumers must
independently verify the pinned release and selected running version. Rollback
uses existing reviewed Git and immutable-release procedures.
