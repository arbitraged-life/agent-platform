#!/usr/bin/env python3
"""Validate a deployable CODEOWNERS file without inventing reviewer identities."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

PLACEHOLDER = re.compile(r"(^|[-_/])(org|team|owner|replace|placeholder)([-_/]|$)", re.I)
OWNER = re.compile(r"@[^/\s@#,]+(?:/[^/\s@#,]+)?$")


def _rule(raw: str) -> tuple[str, list[str]] | None:
    line = raw.split("#", 1)[0].strip()
    if not line:
        return None
    parts = line.split()
    return parts[0], parts[1:]


def _owner_errors(number: int, owners: list[str]) -> list[str]:
    if not owners:
        return [f"line {number}: pattern has no owner"]
    errors: list[str] = []
    for owner in owners:
        if not OWNER.fullmatch(owner):
            errors.append(f"line {number}: invalid owner {owner!r}")
        elif PLACEHOLDER.search(owner[1:]):
            errors.append(f"line {number}: placeholder owner {owner!r}")
    return errors


def validate(text: str) -> list[str]:
    errors: list[str] = []
    catch_all = False
    for number, raw in enumerate(text.splitlines(), start=1):
        rule = _rule(raw)
        if rule is None:
            continue
        pattern, owners = rule
        if pattern in ("*", "**"):
            catch_all = True
        errors.extend(_owner_errors(number, owners))
    if not catch_all:
        errors.append("missing catch-all '*' or '**' owner rule")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, nargs="?", default=Path(".github/CODEOWNERS"))
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        text = args.path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SystemExit(f"cannot read CODEOWNERS: {exc}") from None
    errors = validate(text)
    if args.json:
        print(json.dumps({"ok": not errors, "errors": errors}, indent=2))
    elif errors:
        for error in errors:
            print("ERROR: " + error)
    else:
        print("CODEOWNERS structure passed.")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
