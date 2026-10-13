# Repository quality tools

## Knip

Run `npm ci --ignore-scripts` in the repository root, then `npm run lint:knip`. The strict command fails on findings; `npm run lint:knip:report` displays findings without failing for existing lint issues. Configuration/internal errors still fail. CI runs the report uncached. No automatic deletion or fix is enabled.

Knip covers every tracked JavaScript/TypeScript package manifest without consolidating independent lockfiles. It does not analyze unused Python or shell code. CLI, Worker and externally consumed runtime entrypoints are represented explicitly. Install each package's locked dependencies before interpreting unresolved tool-binary findings.

## Local Turborepo cache

`npm run quality:cached` caches only the advisory Knip report. The key includes source files (including new JS/TS files), manifests, installed dependency-lock metadata and Node/platform/architecture. The wrapper runs in a private staging cache and compares Turbo's actual task fingerprint before and after execution. A changed fingerprint discards both the report and staged cache. Stable artifacts are published by same-filesystem file renames; output is displayed only after validation. A fresh `turbo-v2` namespace avoids reusing reports produced by the older wrapper.

This before/after check is not an immutable worktree snapshot: avoid simultaneous edits in one worktree, particularly changes reverted during a run. Run the uncached strict report before deleting code. `npm run quality:cached -- --summarize` emits Turbo's run summary; `--dry=json` exposes its task/hash information. These diagnostic modes do not establish a passing release gate.

The wrapper selects `--cache=local:rw`; no Vercel account, hosting migration, remote-cache upload or workspace restructuring is involved. Tests, security scans, live checks and deployments remain uncached. Ordinary CI does not reuse the report cache.

## Turborepo agent skill

`npm run skills:install` installs the upstream skill into this checkout for Codex using Skills CLI 1.7.2 and the explicit source revision `b19f6a59ccd89ef98cae5e4d8b30e89489fc00f1`. The command targets the `skills/turborepo` directory through a commit-pinned GitHub tree URL, not the moving default branch. `skills-lock.json` is the CLI installation receipt; the committed package command selects the reviewed source revision. Updating the receipt with a different source does not change this bootstrap command.

The generated `.agents/skills/turborepo/` deployment stays ignored. This command does not install globally or activate every coding client. Read the version-matched documentation in `node_modules/turbo/docs/README.md` when configuring Turbo. Installing the skill and installing the executable are distinct operations.

## pre-commit.ci

The installed App uses `.pre-commit-config.yaml` for JSON/TOML/conflict checks and scoped first-party whitespace/EOF fixes. Vendored skill bytes, licenses and seeded benchmark fixtures are excluded from rewriting. The existing `.githooks/pre-commit` remains unchanged. Run `uvx --from pre-commit==4.5.1 pre-commit run --all-files` to execute the same hooks without replacing local Git hooks.

pre-commit.ci owns monthly updates of its frozen hook pin; Renovate's pre-commit manager is not enabled. Bot-authored commits are checked but do not receive automatic fix commits. The service does not replace tests or security gates.
