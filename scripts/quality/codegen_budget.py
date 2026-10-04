#!/usr/bin/env python3
"""Measure a unified diff against configurable code-generation budgets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shlex
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
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".cs", ".go", ".java",
    ".js", ".jsx", ".kt", ".mjs", ".php", ".py", ".rb", ".rs", ".sh", ".swift", ".ts", ".tsx",
}
HASH_COMMENT_EXTENSIONS = {".py", ".rb", ".sh"}
SLASH_COMMENT_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".cs", ".go", ".java",
    ".js", ".jsx", ".kt", ".mjs", ".php", ".rs", ".swift", ".ts", ".tsx",
}
TEST_PATTERNS = (
    re.compile(r"(^|/)(test|tests|spec|specs)(/|$)", re.I),
    re.compile(r"\.(test|spec)\.[^.]+$", re.I),
    re.compile(r"(^|/)test_[^/]+\.py$", re.I),
    re.compile(r"(^|/)[^/]+_test\.(go|py)$", re.I),
)
HARD_METRICS = {
    "max_changed_files": "changed_files",
    "max_additions": "additions",
    "max_deletions": "deletions",
    "max_total_changes": "total_changes",
    "max_single_file_additions": "max_single_file_additions",
}


def _mapping(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _merge_budget(config: dict, supplied: dict, section: str) -> None:
    if section not in supplied:
        return
    incoming = _mapping(supplied[section], section)
    unknown = set(incoming) - set(DEFAULT[section])
    if unknown:
        raise ValueError(f"unknown {section} budget keys: " + ", ".join(sorted(unknown)))
    config[section].update(incoming)


def load_config_document(raw: str | None) -> dict:
    config = {
        "schema_version": 1,
        "hard": dict(DEFAULT["hard"]),
        "advisory": dict(DEFAULT["advisory"]),
    }
    if raw is None:
        return config
    supplied = _mapping(json.loads(raw), "codegen budget config")
    if supplied.get("schema_version") != 1:
        raise ValueError("unsupported codegen budget schema_version")
    unknown = set(supplied) - {"schema_version", "hard", "advisory"}
    if unknown:
        raise ValueError("unknown codegen budget keys: " + ", ".join(sorted(unknown)))
    _merge_budget(config, supplied, "hard")
    _merge_budget(config, supplied, "advisory")
    return config


def is_test_path(path: str) -> bool:
    return any(pattern.search(path) for pattern in TEST_PATTERNS)


def _comment_state(path: str, line: str, in_block: bool) -> tuple[bool, bool]:
    ext = Path(path).suffix.lower()
    stripped = line.lstrip()
    if ext not in CODE_EXTENSIONS:
        return False, False
    if ext in HASH_COMMENT_EXTENSIONS:
        return stripped.startswith("#"), False
    if ext not in SLASH_COMMENT_EXTENSIONS:
        return False, False
    if in_block:
        return True, "*/" not in stripped
    if stripped.startswith("//"):
        return True, False
    if stripped.startswith("/*"):
        return True, "*/" not in stripped[2:]
    return False, False


def _diff_path(line: str) -> str | None:
    try:
        parts = shlex.split(line)
    except ValueError:
        return None
    if len(parts) == 4 and parts[:2] == ["diff", "--git"] and parts[3].startswith("b/"):
        return parts[3][2:]
    marker = " b/"
    return line.rsplit(marker, 1)[1] if line.startswith("diff --git a/") and marker in line else None


def _header_path(line: str) -> str | None:
    value = line[4:].strip()
    if value == "/dev/null":
        return None
    try:
        parts = shlex.split(value)
        value = parts[0] if parts else value
    except ValueError:
        pass
    return value[2:] if value.startswith("b/") else value


def _new_row() -> dict[str, int]:
    return {"additions": 0, "deletions": 0, "comments": 0}


class DiffCounter:
    def __init__(self) -> None:
        self.files: dict[str, dict[str, int]] = {}
        self.current: str | None = None
        self.in_hunk = False
        self.block_comment = False

    def _set_file(self, path: str | None) -> None:
        if path:
            self.current = path
            self.files.setdefault(path, _new_row())

    def consume(self, line: str) -> None:
        if line.startswith("diff --git "):
            self.current = None
            self.in_hunk = False
            self.block_comment = False
            self._set_file(_diff_path(line))
            return
        if not self.in_hunk:
            if line.startswith("+++ "):
                self._set_file(_header_path(line))
            elif line.startswith("@@"):
                self.in_hunk = True
            return
        if not self.current:
            return
        if line.startswith("+"):
            self.files[self.current]["additions"] += 1
            is_comment, self.block_comment = _comment_state(
                self.current, line[1:], self.block_comment
            )
            if is_comment:
                self.files[self.current]["comments"] += 1
        elif line.startswith("-"):
            self.files[self.current]["deletions"] += 1


def _summarize(files: dict[str, dict[str, int]]) -> dict:
    additions = sum(row["additions"] for row in files.values())
    deletions = sum(row["deletions"] for row in files.values())
    comment_additions = sum(row["comments"] for row in files.values())
    test_additions = sum(row["additions"] for path, row in files.items() if is_test_path(path))
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
        "max_single_file_additions": max((row["additions"] for row in files.values()), default=0),
        "comment_only_additions": comment_additions,
        "comment_only_addition_ratio": comment_additions / additions if additions else 0.0,
        "test_additions": test_additions,
        "source_additions": source_additions,
        "test_to_source_addition_ratio": test_additions / source_additions if source_additions else None,
    }


def measure(diff: str) -> dict:
    counter = DiffCounter()
    for line in diff.splitlines():
        counter.consume(line)
    return _summarize(counter.files)


def evaluate(metrics: dict, config: dict) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    for budget_key, maximum in config["hard"].items():
        metric_key = HARD_METRICS[budget_key]
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
    parser.add_argument("--config-json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    diff = sys.stdin.read()
    try:
        config = load_config_document(args.config_json)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
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
