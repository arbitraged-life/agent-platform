# Repository quality tools

## npm toolchain

The root `packageManager` field pins npm 11.21.1; the Node engine remains `>=24`. npm's [11.21.1 release](https://github.com/npm/cli/releases/tag/v11.21.1) supports that engine range. This toolchain pin is not a project dependency and does not require regenerating either lockfile.

When updating the pin, put the exact npm CLI on `PATH` in an isolated temporary toolchain and confirm `npm --version`; the manifest alone does not switch the executable used by shell scripts or CI. Exercise `npm ci --ignore-scripts --include=dev` at the root and with `--prefix skills/turnstile-spin/templates/worker`, then run `./scripts/validate ci` with the same npm on `PATH` and the validation Python dependencies installed. Preserve both lockfiles and the existing install-script policy. Registry advisory results are evidence for the queried packages, not clearance from every security scanner.

## Knip

The root manifest and lockfile pin Knip 6.44.0. Run `npm ci --ignore-scripts` in the repository root, then `npm run lint:knip`. The strict command fails on findings; `npm run lint:knip:report` displays findings without failing for existing lint issues. Configuration/internal errors still fail. CI runs the report uncached. No automatic deletion or fix is enabled.

Knip covers every tracked JavaScript/TypeScript package manifest without consolidating independent lockfiles. It does not analyze unused Python or shell code. CLI, Worker and externally consumed runtime entrypoints are represented explicitly. Install each package's locked dependencies before interpreting unresolved tool-binary findings.

The explicit `runtime/observability/evidence.mjs` and `runtime/observability/otlp.mjs` entries preserve external consumer APIs: telemetry adapters call `opaqueReference`, and Worker consumers call `validateOtlpConfig` before creating exporters. Those consumers live outside this repository, so internal import counts cannot establish that these exports are unused. Keep entries file-specific rather than treating every runtime module as an entrypoint.

Some advisory findings remain intentional or unresolved: `turbo` is launched through its installed executable path by `scripts/quality-cache.mjs`; `mkfifo` is the POSIX utility used by the outbox FIFO safety test, not an npm dependency; and the template's `WorkerMetadata` describes the exported `SiteverifyResponse._worker` field. No direct consumer call to the shipped `disabledExporter` API has been established; preserve that export until its external contract can be retired explicitly. These findings remain visible, without dependency/binary ignores or export suppression.

## Local Turborepo cache

The root manifest and lockfile pin Turbo 2.11.11. After updating this pin, verify the actual wrapper with `npm run quality:cached -- --summarize` twice in an otherwise unchanged checkout: a fresh local cache should miss first and hit second, with remote caching disabled.

`npm run quality:cached` caches only the advisory Knip report. The key includes source files (including new JS/TS files), manifests, installed dependency-lock metadata and Node/platform/architecture. The wrapper runs in a private staging cache and compares Turbo's actual task fingerprint before and after execution. A changed fingerprint discards both the report and staged cache. Stable artifacts are published by same-filesystem file renames; output is displayed only after validation. A fresh `turbo-v2` namespace avoids reusing reports produced by the older wrapper.

This before/after check is not an immutable worktree snapshot: avoid simultaneous edits in one worktree, particularly changes reverted during a run. Run the uncached strict report before deleting code. `npm run quality:cached -- --summarize` emits Turbo's run summary; `--dry=json` exposes its task/hash information. These diagnostic modes do not establish a passing release gate.

The wrapper selects `--cache=local:rw`; no Vercel account, hosting migration, remote-cache upload or workspace restructuring is involved. Tests, security scans, live checks and deployments remain uncached. Ordinary CI does not reuse the report cache.

## Turborepo agent skill

`npm run skills:install` installs the upstream skill into this checkout for Codex using Skills CLI 1.7.2 and the explicit source revision `b19f6a59ccd89ef98cae5e4d8b30e89489fc00f1`. The command targets the `skills/turborepo` directory through a commit-pinned GitHub tree URL, not the moving default branch. `skills-lock.json` is the CLI installation receipt; the committed package command selects the reviewed source revision. Updating the receipt with a different source does not change this bootstrap command.

The generated `.agents/skills/turborepo/` deployment stays ignored. This command does not install globally or activate every coding client. Read the version-matched documentation in `node_modules/turbo/docs/README.md` when configuring Turbo. Installing the skill and installing the executable are distinct operations.

## pre-commit.ci

The installed App uses `.pre-commit-config.yaml` for JSON/TOML/conflict checks and scoped first-party whitespace/EOF fixes. Vendored skill bytes, licenses and seeded benchmark fixtures are excluded from rewriting. The existing `.githooks/pre-commit` remains unchanged. Run `uvx --from pre-commit==4.5.1 pre-commit run --all-files` to execute the same hooks without replacing local Git hooks.

pre-commit.ci owns monthly updates of its frozen hook pin; Renovate's pre-commit manager is not enabled. Bot-authored commits are checked but do not receive automatic fix commits. The service does not replace tests or security gates.
