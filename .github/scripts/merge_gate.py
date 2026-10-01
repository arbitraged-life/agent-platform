#!/usr/bin/env python3
"""Bounded GitHub PR auto-merge coordinator and check-evidence policy."""

from __future__ import annotations

import argparse
import json
import re
# qlty-ignore(bandit:B404): Required CLI execution uses argv arrays without a shell.
import subprocess
import shutil
import sys
from dataclasses import dataclass
from typing import Any


GH_EXECUTABLE = shutil.which('gh')


_SHA = re.compile(r"^[0-9a-f]{40}$")
_UUID4 = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
_RECEIPT_ID = re.compile(
    rf"^({_UUID4}):({_UUID4}):attempt-([1-9][0-9]*):pr-([1-9][0-9]*):({_UUID4})$"
)
_MERGE_METHODS = {"merge", "squash", "rebase"}


@dataclass(frozen=True)
class EvidenceDecision:
    allowed: bool
    source: str
    reason: str


def _single_success(records: list[dict[str, Any]], *, workflow: str, sha: str) -> str | None:
    matches = [record for record in records if record.get("workflow") == workflow]
    if not matches:
        return f"missing required Actions workflow {workflow}"
    if len(matches) != 1:
        return f"ambiguous Actions evidence for {workflow}"
    record = matches[0]
    if record.get("head_sha") != sha:
        return f"required Actions workflow {workflow} has stale head SHA"
    if record.get("status") != "completed":
        return f"required Actions workflow {workflow} is pending or non-terminal"
    if record.get("conclusion") != "success":
        return f"required Actions workflow {workflow} concluded {record.get('conclusion') or 'unknown'}"
    return None


def _single_provider_success(
    records: list[dict[str, Any]], *, workflow: str, sha: str, pr_number: int, publisher_id: int
) -> str | None:
    name = f"CircleCI / {workflow}"
    matches = [record for record in records if record.get("name") == name]
    if not matches:
        return f"missing required provider workflow {workflow}"
    if len(matches) != 1:
        return f"ambiguous provider evidence for {workflow}"
    record = matches[0]
    if record.get("app_id") != publisher_id:
        return f"provider workflow {workflow} has untrusted publisher"
    if record.get("head_sha") != sha:
        return f"provider workflow {workflow} has stale head SHA"
    if record.get("status") != "completed":
        return f"provider workflow {workflow} is pending or non-terminal"
    if record.get("conclusion") != "success":
        return f"provider workflow {workflow} concluded {record.get('conclusion') or 'unknown'}"
    receipt = _RECEIPT_ID.fullmatch(str(record.get("external_id", "")))
    if not receipt:
        return f"provider workflow {workflow} has no valid attempt/PR/correlation receipt"
    if int(receipt.group(4)) != pr_number:
        return f"provider workflow {workflow} receipt PR does not match current PR"
    return None


def _provider_decision(head_sha, pr_number, publisher_id, workflows, checks):
    workflows = workflows or []
    if (
        not isinstance(publisher_id, int)
        or publisher_id <= 0
        or not isinstance(pr_number, int)
        or pr_number <= 0
        or not workflows
    ):
        return EvidenceDecision(False, "provider", "provider configuration requires a trusted publisher ID, PR number, and required workflow set")
    if len(workflows) != len(set(workflows)):
        return EvidenceDecision(False, "provider", "provider configuration has duplicate required workflows")
    for workflow in workflows:
        reason = _single_provider_success(
            checks or [],
            workflow=workflow,
            sha=head_sha,
            pr_number=pr_number,
            publisher_id=publisher_id,
        )
        if reason:
            return EvidenceDecision(False, "provider", reason)
    return EvidenceDecision(True, "provider", "all required provider workflows passed")


def evaluate_evidence(
    *,
    head_sha: str,
    pr_number: int | None = None,
    required_actions: list[str],
    action_runs: list[dict[str, Any]],
    provider_enabled: bool = False,
    trusted_publisher_app_id: int | None = None,
    required_provider_workflows: list[str] | None = None,
    provider_checks: list[dict[str, Any]] | None = None,
) -> EvidenceDecision:
    """Evaluate mandatory evidence. Advisory failures never substitute or block."""
    if not _SHA.fullmatch(head_sha):
        return EvidenceDecision(False, "none", "invalid current PR head SHA")
    if provider_enabled:
        return _provider_decision(head_sha, pr_number, trusted_publisher_app_id,
                                  required_provider_workflows, provider_checks)

    if not required_actions:
        return EvidenceDecision(False, "actions", "Actions configuration has no required workflow")
    if len(required_actions) != len(set(required_actions)):
        return EvidenceDecision(False, "actions", "Actions configuration has duplicate required workflows")
    for workflow in required_actions:
        reason = _single_success(action_runs, workflow=workflow, sha=head_sha)
        if reason:
            return EvidenceDecision(False, "actions", reason)
    # Advisory checks are informational and never affect the merge decision.
    return EvidenceDecision(True, "actions", "all required Actions workflows passed")


def _gh_json(*args: str) -> Any:
    if GH_EXECUTABLE is None:
        raise ValueError("gh executable is required for GitHub operations")
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    completed = subprocess.run([GH_EXECUTABLE, "api", *args], check=True, capture_output=True, text=True, timeout=30)
    return json.loads(completed.stdout)


def _gh_pr_json(*args: str) -> Any:
    if GH_EXECUTABLE is None:
        raise ValueError("gh executable is required for GitHub operations")
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    completed = subprocess.run([GH_EXECUTABLE, "pr", *args], check=True, capture_output=True, text=True, timeout=30)
    return json.loads(completed.stdout)


def _parse_json_list(value: str, option: str) -> list[str]:
    try:
        result = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{option} must be a JSON array of workflow names") from exc
    if not isinstance(result, list) or any(not isinstance(item, str) or not item for item in result):
        raise ValueError(f"{option} must be a JSON array of non-empty workflow names")
    return result


def _get_action_runs(repo: str, workflow: str, sha: str) -> list[dict[str, Any]]:
    data = _gh_json(f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100")
    runs = data.get("workflow_runs", [])
    return [
        {
            "workflow": workflow,
            "head_sha": run.get("head_sha"),
            "status": run.get("status"),
            "conclusion": run.get("conclusion"),
            "run_id": run.get("id"),
            "run_attempt": run.get("run_attempt"),
        }
        for run in runs
    ]


def _check_page(data, expected_count, collected):
    rows = data.get("check_runs")
    total = data.get("total_count")
    if not isinstance(rows, list) or type(total) is not int or total < 0 or len(rows) > 100:
        raise ValueError("invalid GitHub check-run page response")
    if total > 1000:
        raise ValueError("provider check count exceeds the bounded 1000-check scan")
    if expected_count is not None and total != expected_count:
        raise ValueError("provider check result changed while paging; retry a fresh pass")
    if collected + len(rows) > total:
        raise ValueError("provider check result changed while paging; retry a fresh pass")
    return rows, total


def _scan_provider_checks(repo, sha):
    checks = []
    expected_count = None
    for page in range(1, 11):
        data = _gh_json(f"repos/{repo}/commits/{sha}/check-runs?filter=all&per_page=100&page={page}")
        rows, expected_count = _check_page(data, expected_count, len(checks))
        checks.extend(rows)
        if len(checks) == expected_count:
            return checks, page
        if len(rows) != 100:
            raise ValueError("truncated GitHub check-run page; refusing incomplete provider evidence")
    raise ValueError("provider check result exceeds the bounded page scan")


def _get_provider_checks(repo: str, sha: str) -> list[dict[str, Any]]:
    checks, pages = _scan_provider_checks(repo, sha)
    if pages > 1:
        second_pass, _ = _scan_provider_checks(repo, sha)
        if checks != second_pass:
            raise ValueError("provider check result changed between scans; retry a fresh pass")
    return [
        {
            "name": check.get("name"),
            "head_sha": check.get("head_sha"),
            "app_id": (check.get("app") or {}).get("id"),
            "status": check.get("status"),
            "conclusion": check.get("conclusion"),
            "external_id": check.get("external_id"),
        }
        for check in checks
    ]


def _collect_action_runs(repo, sha, required_actions, advisory, number):
    action_runs: list[dict[str, Any]] = []
    for workflow in required_actions:
        action_runs.extend(_get_action_runs(repo, workflow, sha))
    required_action_set = set(required_actions)
    for workflow in advisory:
        if workflow in required_action_set:
            continue
        try:
            action_runs.extend(_get_action_runs(repo, workflow, sha))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
            print(f"PR #{number}: advisory Actions workflow {workflow}: unavailable ({exc})")
    for workflow in advisory:
        results = [run for run in action_runs if run.get("workflow") == workflow]
        if len(results) != 1:
            state = "missing" if not results else "ambiguous"
            print(f"PR #{number}: advisory Actions workflow {workflow}: {state}")
        else:
            result = results[0]
            print(
                f"PR #{number}: advisory Actions workflow {workflow}: "
                f"{result.get('status')}/{result.get('conclusion') or 'pending'}"
            )
    return action_runs


def _process_pr(args: argparse.Namespace, repo: str, number: int, required_actions: list[str], advisory: list[str], provider_workflows: list[str]) -> bool:
    pr = _gh_pr_json("view", str(number), "--repo", repo, "--json", "number,state,headRefOid,mergeable,labels")
    labels = {label["name"] for label in pr.get("labels", [])}
    if pr.get("state") != "OPEN" or args.label not in labels:
        return False
    initial_sha = pr.get("headRefOid")
    if not isinstance(initial_sha, str) or not _SHA.fullmatch(initial_sha):
        print(f"PR #{number}: invalid head SHA; skipping")
        return False
    if pr.get("mergeable") != "MERGEABLE":
        print(f"PR #{number}: mergeability is {pr.get('mergeable')}; skipping")
        return False

    action_runs = _collect_action_runs(repo, initial_sha, required_actions, advisory, number)
    provider_checks = _get_provider_checks(repo, initial_sha) if args.provider_enabled else []
    decision = evaluate_evidence(
        head_sha=initial_sha,
        pr_number=number,
        required_actions=required_actions,
        action_runs=action_runs,
        provider_enabled=args.provider_enabled,
        trusted_publisher_app_id=args.trusted_publisher_app_id,
        required_provider_workflows=provider_workflows,
        provider_checks=provider_checks,
    )
    if not decision.allowed:
        print(f"PR #{number}: {decision.reason}; skipping")
        return False

    # Re-read immediately before merge; the server-side SHA guard closes the remaining race.
    latest = _gh_pr_json("view", str(number), "--repo", repo, "--json", "state,headRefOid,mergeable,labels")
    latest_labels = {label["name"] for label in latest.get("labels", [])}
    if (
        latest.get("state") != "OPEN"
        or args.label not in latest_labels
        or latest.get("headRefOid") != initial_sha
        or latest.get("mergeable") != "MERGEABLE"
    ):
        print(f"PR #{number}: eligibility/head changed before merge; skipping")
        return False

    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    result = subprocess.run(
        [GH_EXECUTABLE, "pr", "merge", str(number), "--repo", repo, f"--{args.merge_method}", "--delete-branch", "--match-head-commit", initial_sha],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode:
        print(f"PR #{number}: merge rejected: {result.stderr.strip() or result.stdout.strip()}")
        return False
    print(f"PR #{number}: merged at expected head {initial_sha} ({decision.source})")
    return True


def _validate_options(args):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        raise ValueError("--repo must be owner/name")
    if not 1 <= args.max_prs <= 100:
        raise ValueError("--max-prs must be between 1 and 100")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.ya?ml", args.gate_workflow):
        raise ValueError("--gate-workflow must be a workflow filename")
    if args.provider_enabled and (args.trusted_publisher_app_id is None or args.trusted_publisher_app_id <= 0):
        raise ValueError("provider opt-in requires --trusted-publisher-app-id")
    advisory = _parse_json_list(args.advisory_workflows, "--advisory-workflows")
    provider_workflows = _parse_json_list(args.provider_required_workflows, "--provider-required-workflows")
    if len(advisory) > 20 or len(provider_workflows) > 20:
        raise ValueError("workflow lists are limited to 20 entries per coordinator pass")
    if len(advisory) != len(set(advisory)) or len(provider_workflows) != len(set(provider_workflows)):
        raise ValueError("workflow lists must not contain duplicates")
    if any(not re.fullmatch(r"[A-Za-z0-9_.-]+\.ya?ml", workflow) for workflow in advisory):
        raise ValueError("--advisory-workflows entries must be workflow filenames")
    if args.provider_enabled and not provider_workflows:
        raise ValueError("provider opt-in requires --provider-required-workflows")
    required_actions = [] if args.provider_enabled else [args.gate_workflow]
    return required_actions, advisory, provider_workflows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/name repository")
    parser.add_argument("--gate-workflow", required=True, help="required Actions workflow filename (Actions-only default)")
    parser.add_argument("--label", default="auto-merge", help="label opting a PR into merge")
    parser.add_argument("--merge-method", choices=sorted(_MERGE_METHODS), default="squash")
    parser.add_argument("--advisory-workflows", default="[]", help="JSON array of advisory Actions workflow filenames")
    parser.add_argument("--provider-enabled", action="store_true", help="explicitly opt in to trusted provider checks")
    parser.add_argument("--trusted-publisher-app-id", type=int, help="exact GitHub App ID allowed to publish provider checks")
    parser.add_argument("--provider-required-workflows", default="[]", help="JSON array of required provider workflow names")
    parser.add_argument("--max-prs", type=int, default=100, help="maximum labeled PRs processed per invocation (1..100)")
    args = parser.parse_args()

    try:
        required_actions, advisory, provider_workflows = _validate_options(args)

        numbers = _gh_pr_json("list", "--repo", args.repo, "--state", "open", "--label", args.label, "--limit", str(args.max_prs), "--json", "number")
        merged = 0
        for row in numbers:
            merged += _process_pr(args, args.repo, row["number"], required_actions, advisory, provider_workflows)
        print(f"Coordinator pass complete: considered={len(numbers)} merged={merged} limit={args.max_prs}")
        return 0
    except (ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired, KeyError) as exc:
        detail = getattr(exc, "stderr", None)
        print(f"Coordinator unavailable or misconfigured; fail closed: {detail or exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
