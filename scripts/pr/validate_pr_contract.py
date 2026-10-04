#!/usr/bin/env python3
"""Validate deterministic pull-request structure without judging semantic truth."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

DEFAULT = {
    "schema_version": 1,
    "required_sections": ["Why", "What", "Verification", "Risk / Rollback"],
    "minimum_section_characters": {
        "Why": 20,
        "What": 20,
        "Verification": 8,
        "Risk / Rollback": 8,
    },
    "maximum_body_characters": 12000,
    "title_pattern": r"^(feat|fix|chore|refactor|docs|test|perf|ci)(\([a-z0-9._-]+\))?: .{8,}$",
}


def normalize_heading(value: str) -> str:
    return " ".join(value.strip().split()).casefold()


def parse_sections(body: str) -> dict[str, str]:
    matches = list(re.finditer(r"(?m)^##\s+(.+?)\s*$", body))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        sections[normalize_heading(match.group(1))] = body[match.end():end].strip()
    return sections


def meaningful_length(text: str) -> int:
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"(?m)^\s*[-*+]\s*", "", text)
    return len(" ".join(text.split()))


def load_config(path: Path | None) -> dict:
    config = dict(DEFAULT)
    config["minimum_section_characters"] = dict(DEFAULT["minimum_section_characters"])
    if path is None:
        return config
    supplied = json.loads(path.read_text(encoding="utf-8"))
    if supplied.get("schema_version") != 1:
        raise ValueError("unsupported PR contract schema_version")
    unknown = set(supplied) - set(DEFAULT)
    if unknown:
        raise ValueError("unknown PR contract keys: " + ", ".join(sorted(unknown)))
    config.update(supplied)
    config["minimum_section_characters"] = {
        **DEFAULT["minimum_section_characters"],
        **supplied.get("minimum_section_characters", {}),
    }
    return config


def validate(title: str, body: str, config: dict) -> list[str]:
    errors: list[str] = []
    if len(body) > int(config["maximum_body_characters"]):
        errors.append(
            f"PR body is {len(body)} characters; maximum is {config['maximum_body_characters']}"
        )
    pattern = config.get("title_pattern")
    if pattern and not re.fullmatch(pattern, title.strip()):
        errors.append("PR title does not match the configured deterministic pattern")

    sections = parse_sections(body)
    for heading in config["required_sections"]:
        key = normalize_heading(heading)
        if key not in sections:
            errors.append(f"missing required section: ## {heading}")
            continue
        minimum = int(config["minimum_section_characters"].get(heading, 1))
        size = meaningful_length(sections[key])
        if size < minimum:
            errors.append(
                f"section ## {heading} has {size} meaningful characters; minimum is {minimum}"
            )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--body-file", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    body = args.body_file.read_text(encoding="utf-8") if args.body_file else sys.stdin.read()
    try:
        config = load_config(args.config)
    except (OSError, ValueError) as exc:
        raise SystemExit(f"invalid PR contract config: {exc}") from None
    errors = validate(args.title, body, config)
    if args.json:
        print(json.dumps({"ok": not errors, "errors": errors}, indent=2))
    elif errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
    else:
        print("PR structure contract passed.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
