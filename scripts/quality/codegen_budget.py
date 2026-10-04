#!/usr/bin/env python3
"""Measure a unified diff against configurable code-generation budgets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

DEFAULT = {
    "schema_version": 1,
    "hard": {
        "max_changed_files": 20,
        "max_additions": 800,
        "max_deletions": 500,
        "max_total_changes": 1200,
        "max_single_file_additions": 400,
    },
    "advisory": {
        "max_comment_only_addition_ratio": 0.35,
        "max_test_to_source_addition_ratio": 2.5,
    },
}

CODE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".go", ".java", ".js", ".jsx", ".kt", ".mjs",
    ".php", ".py", ".rb", ".rs", ".sh", ".swift", ".ts", ".tsx",
}
TEST_PATTERNS = (
    re.compile(r"(^|/)(test|tests|spec|specs)(/|$)", re.I),
    re.compile(r"\.(test|spec)\.[^.]+$", re.I),
)

HARD_METRICS = {
    "max_changed_files": "changed_files",
    "max_additions": "additions",
    "max_deletions": "deletions",
    "max_total_changes": "total_changes",
    "max_single_file_additions": "max_single_file_additions",
}


def load_config(path: Path | None) -> dict:
    config = {
        "schema_version": 1,
        "hard": dict(DEFAULT["hard"]),
        "advisory": dict(DEFAULT["advisory"]),
    }
    if path is None:
        return config
    supplied = json.loads(path.read_text(encoding="utf-8"))
    if supplied.get("schema_version") != 1:
        raise ValueError("unsupported codegen budget schema_version")
    unknown = set(supplied) - {"schema_version", "hard", "advisory"}
    if unknown:
        raise ValueError("unknown codegen budget keys: " + ", ".join(sorted(unknown)))
    config["hard"].update(supplied.get("hard", {}))
    config["advisory"].update(supplied.get("advisory", {}))
    return config


def is_test_path(path: str) -> bool:
    return any(pattern.search(path) for pattern in TEST_PATTERNS)


def is_comment_only(path: str, line: str) -> bool:
    if Path(path).suffix.lower() not in CODE_EXTENSIONS:
        return False
    stripped = line.lstrip()
    return stripped.startswith(("#", "//", "/*", "*", "*/"))


def measure(diff: str) -> dict:
    files: dict[str, dict[str, int]] = {}
    current: str | None = None
    for line in diff.splitlines():
        if line.startswith("diff --git "):
            match = re.match(r"diff --git a/(.+?) b/(.+)$", line)
            current = match.group(2) if match else None
            if current:
                files.setdefault(current, {"additions": 0, "deletions": 0, "comments": 0})
            continue
        if not current:
            continue
        if line.startswith("+++ ") or line.startswith("--- "):
            continue
        if line.startswith("+"):
            files[current]["additions"] += 1
            if is_comment_only(current, line[1:]):
                files[current]["comments"] += 1
        elif line.startswith("-"):
            files[current]["deletions"] += 1

    additions = sum(row["additions"] for row in files.values())
    deletions = sum(row["deletions"] for row in files.values())
    comment_additions = sum(row["comments"] for row in files.values())
    test_additions = sum(
        row["additions"] for path, row in files.items() if is_test_path(path)
    )
    source_additions = sum(
        row["additions"]
        for path, row in files.items()
        if not is_test_path(path) and Path(path).suffix.lower() in CODE_EXTENSIONS
    )
    return {
        "changed_files": len(files),
        "additions": additions,
        "deletions": deletions,
        "total_changes": additions + deletions,
        "max_single_file_additions": max(
            (row["additions"] for row in files.values()), default=0
        ),
        "comment_only_additions": comment_additions,
        "comment_only_addition_ratio": (
            comment_additions / additions if additions else 0.0
        ),
        "test_additions": test_additions,
        "source_additions": source_additions,
        "test_to_source_addition_ratio": (
            test_additions / source_additions if source_additions else None
        ),
    }


def evaluate(metrics: dict, config: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    for budget_key, maximum in config["hard"].items():
        metric_key = HARD_METRICS.get(budget_key)
        if metric_key is None:
            errors.append(f"unknown hard budget: {budget_key}")
            continue
        value = metrics[metric_key]
        if value > maximum:
            errors.append(f"{metric_key}={value} exceeds hard maximum {maximum}")

    comment_max = config["advisory"].get("max_comment_only_addition_ratio")
    if comment_max is not None and metrics["comment_only_addition_ratio"] > comment_max:
        warnings.append(
            "comment_only_addition_ratio="
            f"{metrics['comment_only_addition_ratio']:.3f} exceeds advisory {comment_max}"
        )

    test_max = config["advisory"].get("max_test_to_source_addition_ratio")
    ratio = metrics["test_to_source_addition_ratio"]
    if test_max is not None and ratio is not None and ratio > test_max:
        warnings.append(
            f"test_to_source_addition_ratio={ratio:.3f} exceeds advisory {test_max}"
        )
    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--diff-file", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    diff = args.diff_file.read_text(encoding="utf-8") if args.diff_file else sys.stdin.read()
    try:
        config = load_config(args.config)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"invalid codegen budget config: {exc}") from None
    metrics = measure(diff)
    errors, warnings = evaluate(metrics, config)
    payload = {"ok": not errors, "metrics": metrics, "errors": errors, "warnings": warnings}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(metrics, sort_keys=True))
        for warning in warnings:
            print("WARNING: " + warning, file=sys.stderr)
        for error in errors:
            print("ERROR: " + error, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
