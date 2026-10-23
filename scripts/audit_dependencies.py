#!/usr/bin/env python3
"""Fail-closed, read-only advisory audit of every owned npm lockfile.

Dependency changes come from Renovate/approved PRs. This checker does not
install, regenerate lockfiles, or mutate provider/account settings.
"""
import json
from pathlib import Path
# qlty-ignore(bandit:B404): Fixed npm audit argv, no shell or package install.
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
LOCKFILES = (
    "package-lock.json",
    "skills/turnstile-spin/templates/worker/package-lock.json",
)
SEVERITIES = ("info", "low", "moderate", "high", "critical")


def audit_dependencies(root=ROOT, *, runner=subprocess.run):
    reports = []
    for relative in LOCKFILES:
        lock = root / relative
        manifest = lock.parent / "package.json"
        if not lock.is_file() or not manifest.is_file():
            raise RuntimeError(f"Missing audited package manifest/lock: {relative}")
        # npm audit uses the registry to check advisories. Lockfile-only ensures
        # no install or lockfile rewrite; include devDependencies (e.g. Vite).
        command = ["npm", "audit", "--package-lock-only", "--audit-level=high",
                   "--json", "--ignore-scripts", "--no-fund"]
        try:
            result = runner(command, cwd=lock.parent, capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"Dependency advisory lookup unavailable: {relative}") from exc
        try:
            report = json.loads(result.stdout)
            counts = report["metadata"]["vulnerabilities"]
            if any(type(counts.get(level)) is not int or counts[level] < 0 for level in SEVERITIES):
                raise ValueError("invalid advisory counts")
            issues = report.get("vulnerabilities", {})
            if not isinstance(issues, dict):
                raise ValueError("invalid vulnerability map")
        except (ValueError, KeyError, TypeError) as exc:
            raise RuntimeError(f"Dependency advisory response unavailable: {relative}") from exc
        exposed = sorted(name for name, detail in issues.items()
                         if isinstance(detail, dict) and detail.get("severity") in {"high", "critical"})
        reports.append({"lockfile": relative, "counts": {k: counts[k] for k in SEVERITIES},
                        "vulnerable_high_packages": exposed})
        if result.returncode != 0 or exposed or counts["high"] or counts["critical"]:
            names = ", ".join(exposed[:20]) or "unclassified audit failure"
            raise RuntimeError(f"Unresolved high/critical dependency advisories in {relative}: {names}")
    return reports


def main():
    try:
        reports = audit_dependencies()
    except RuntimeError as error:
        print(f"Dependency advisory check failed closed: {error}", file=sys.stderr)
        return 1
    for report in reports:
        counts = report["counts"]
        print(f"{report['lockfile']}: high={counts['high']}, critical={counts['critical']}; "
              f"lower-severity advisories={counts['low']+counts['moderate']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
