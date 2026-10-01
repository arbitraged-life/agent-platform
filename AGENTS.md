# Agent Platform

This repository owns reusable runtime components, skills, evals, and workflows.
Deployment policy, secret references, private datasets, and machine configuration
belong to consuming repositories. The public package has no reverse dependency.

Validation entrypoint: `./scripts/validate`. Tests use the native Node test runner
and Python unittest. The public release contains no third-party runtime packages.

Runtime modules live under `runtime/`; executable entrypoints under `scripts/`;
portable skill folders under `skills/`; deterministic evals under `evals/`.
Local instructions describe component-specific contracts. Lifecycle enforcement
is implemented in executable validation and runtime hooks.

Release identity is a Git commit plus artifact SHA-256, consumed through an
explicit lock. This repository runs public CI on hosted runners with commit-pinned actions.
Reusable workflows accept trusted caller configuration; runner ownership stays
with the consuming repository.
