# Repository quality tools

## Knip

Run `npm ci --ignore-scripts` in the repository root, then `npm run lint:knip`. This strict command exits 1 on findings and 2 on configuration/internal errors. `npm run lint:knip:report` reports the same findings without failing for existing lint issues; genuine tool errors still fail. The existing CI runs the report uncached. No automatic deletion or fix is enabled.

The configuration covers every tracked package manifest as a Knip workspace, without converting the package-manager layout or consolidating independent lockfiles. It analyzes JavaScript/TypeScript, not unused Python or shell code. Source-defined CLI/Worker/agent entrypoints and externally consumed runtime exports need explicit representation; a finding is not automatic authorization to remove code. Install a package's locked dependencies to resolve its tool binaries fully before acting on an unlisted-binary report.

## Local Turborepo trial

`npm run quality:cached` runs only the Knip report through pinned Turborepo. It fingerprints tracked/default source inputs, installed npm dependency-lock metadata, and the Node version, operating system and architecture. Unchanged inputs replay the cached report; edits invalidate it. Cache and reports stay in ignored `_state/quality-cache/`. `npm run quality:cached -- --summarize` emits an inspectable run summary.

This is an opt-in single-package task trial: code stays in place and existing independent package lockfiles remain independent. No code hosting migration, Vercel account, remote-cache upload, paid plan or new persistent daemon is required. The command explicitly uses `--cache=local:rw`. Tests, security scans, deployments and live integration checks are not cached. Normal CI never uses this trial cache. A cached advisory report is not a passing release gate.

## Turborepo agent skill

The upstream Turborepo skill is installed with `npx --yes skills@1.7.2 add vercel/turborepo --skill turborepo --agent codex --copy --yes`. `skills-lock.json` records the source and hash. The ignored `.agents/skills/turborepo/` directory is a local agent deployment; repeat the command in a fresh checkout to install it. This does not modify global clients or launch a coding agent. The skill points to the version-matched documentation bundled in `node_modules/turbo/docs/README.md`; installing the skill alone does not install Turborepo. Both are installed for this trial.

## pre-commit.ci

The installed GitHub App consumes `.pre-commit-config.yaml`: pinned upstream hooks check JSON, TOML and conflict markers, and fix trailing whitespace/end-of-file issues in first-party code/docs/config. Vendored skill bytes, licenses and seeded benchmark fixtures are not reformatted. The existing `.githooks/pre-commit` remains the local authority and is not replaced. Run `uvx --from pre-commit==4.5.1 pre-commit run --all-files` for the same hosted checks without installing another local Git hook.

pre-commit.ci owns monthly updates of its frozen hook pin; Renovate's pre-commit manager is not enabled. The service checks bot commits but does not push autofixes to bot-authored commits. It is not a dependency-review or security-gate replacement.
