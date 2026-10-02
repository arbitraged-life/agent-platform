# Reusable lint contract

`lint-reusable.yml` detects tracked Swift, Python, JavaScript/TypeScript, shell,
YAML and C/C++ sources. Vendored/generated directory names are excluded from
language discovery. Each linter retains its native configuration behavior.
Rust was never checked by the source workflow and is not advertised here.

Call the workflow using an immutable commit SHA. Inputs `strict` and
`swift_strict` preserve the existing interface. Ordinary lint findings are
advisory by default; strict mode fails on findings, and Swift strict mode also
fails on warnings. Installation failures and secret findings block in either
mode. No inherited secrets, private repository access or provider calls are used.

Actions and tool versions are pinned. Downloaded SwiftLint and Gitleaks archives
are SHA-256 checked before extraction. Ubuntu package versions come from the
Ubuntu 24.04 signed repository; hosted runner images and OS transitive packages
remain externally maintained, so this is not a hermetic build environment.

A reusable workflow runs in the caller's billing and permission context. Hosting
its definition publicly does not turn private caller jobs into public CI.
Public platform CI validates workflow behavior with synthetic fixtures.
