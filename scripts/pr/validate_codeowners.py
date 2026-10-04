#!/usr/bin/env python3
"""Validate a deployable CODEOWNERS file without inventing reviewer identities."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re

PLACEHOLDER = re.compile(r"(^|[-_/])(org|team|owner|replace|placeholder)([-_/]|$)", re.I)


def validate(text: str) -> list[str]:
    errors: list[str] = []
    catch_all = False
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            errors.append(f"line {number}: pattern has no owner")
            continue
        pattern, owners = parts[0], parts[1:]
        if pattern == "*":
            catch_all = True
        for owner in owners:
            if not owner.startswith("@") or len(owner) < 2:
                errors.append(f"line {number}: invalid owner {owner!r}")
                continue
            if PLACEHOLDER.search(owner[1:]):
                errors.append(f"line {number}: placeholder owner {owner!r}")
    if not catch_all:
        errors.append("missing catch-all '*' owner rule")
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
