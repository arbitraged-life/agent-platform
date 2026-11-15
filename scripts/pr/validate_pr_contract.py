#!/usr/bin/env python3
"""Validate deterministic pull-request structure without judging semantic truth."""
from __future__ import annotations

import argparse
import json
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
    "title_types": ["feat", "fix", "chore", "refactor", "docs", "test", "perf", "ci"],
    "minimum_title_subject_characters": 8,
}


def normalize_heading(value: str) -> str:
    return " ".join(value.strip().split()).casefold()


def _fence_marker(line: str) -> tuple[str, int, str] | None:
    marker = re.match(r" {0,3}(`{3,}|~{3,})", line)
    if marker is None:
        return None
    fence = marker.group(1)
    return fence[0], len(fence), line[marker.end():].strip()


def _closes_fence(marker: tuple[str, int, str] | None, fence: tuple[str, int]) -> bool:
    if marker is None:
        return False
    return marker[0] == fence[0] and marker[1] >= fence[1] and not marker[2]


_LIST_ITEM = re.compile(r" {0,3}(?:[-+*]|[0-9]{1,9}[.)])(?P<padding> +|$)")


def _opening_fence(line: str, list_indents: list[int]) -> tuple[str, int, int] | None:
    """Track list containers, then apply the fence rule relative to their content."""
    expanded = line.expandtabs(4)
    if line.strip():
        while list_indents and not expanded.startswith(" " * list_indents[-1]):
            list_indents.pop()
    indent = list_indents[-1] if list_indents else 0
    while item := _LIST_ITEM.match(expanded[indent:].rstrip("\r\n")):
        padding = len(item.group("padding"))
        width = item.end() - padding + (padding if 1 <= padding <= 4 else 1)
        indent += width
        list_indents.append(indent)
    # Tabs are expanded only while removing a list container, never to relax
    # the top-level 0–3-space fence rule.
    content = expanded[indent:] if indent else line
    marker = _fence_marker(content)
    return (marker[0], marker[1], indent) if marker is not None else None


def _consume_fenced_line(line: str, fence: tuple[str, int, int]
                         ) -> tuple[bool, tuple[str, int, int] | None]:
    indent = fence[2]
    expanded = line.expandtabs(4) if indent else line
    if indent and line.strip() and not expanded.startswith(" " * indent):
        return False, None  # A fenced block cannot outlive its list container.
    marker = _fence_marker(expanded[indent:])
    return True, None if _closes_fence(marker, fence[:2]) else fence


_BLOCK_START = re.compile(
    r" {0,3}(?:#{1,6}(?:[ \t]|$)|>|(?:[-+*]|1[.)])[ \t]+|<!--"
    r"|(?:=+|-+)[ \t]*$|(?P<rule>[_*])(?:[ \t]*(?P=rule)){2,}[ \t]*$)"
)


def _ends_code_span_block(line: str, heading: bool) -> bool:
    if heading or not line.strip():
        return True
    return _BLOCK_START.match(line.rstrip("\r\n")) is not None or _fence_marker(line) is not None


def _code_span_end(lines: list[str], line_index: int, position: int,
                   delimiter: str) -> tuple[int, int] | None:
    heading = re.match(r" {0,3}#{1,6}(?:[ \t]|$)", lines[line_index]) is not None
    for index in range(line_index, len(lines)):
        candidate = lines[index]
        if index > line_index and _ends_code_span_block(candidate, heading):
            break
        start = position if index == line_index else 0
        for closing in re.finditer(r"`+", candidate[start:]):
            if closing.group() == delimiter:
                return index, start + closing.end()
    return None


def _is_escaped(line: str, start: int) -> bool:
    escape_start = start
    while escape_start > 0 and line[escape_start - 1] == "\\":
        escape_start -= 1
    return (start - escape_start) % 2 != 0


def _mask_comment_tail(line: str, position: int, output: list[str]) -> tuple[int, bool]:
    end = line.find("-->", position)
    closed = end != -1
    stop = end + 3 if closed else len(line)
    output.append(re.sub(r"[^\r\n]", " ", line[position:stop]))
    return stop, not closed


def _mask_line_comments(lines: list[str], index: int, position: int,
                        commented: bool, output: list[str]) -> tuple[bool, tuple[int, int] | None]:
    line = lines[index]
    while position < len(line):
        if commented:
            position, commented = _mask_comment_tail(line, position, output)
            continue
        token = re.search(r"<!--|`+", line[position:])
        if token is None:
            output.append(line[position:])
            break
        start = position + token.start()
        output.append(line[position:start])
        if _is_escaped(line, start):
            output.append(line[start:start + 1])
            position = start + 1
            continue
        if token.group() == "<!--":
            position = start
            commented = True
            continue
        position = start + len(token.group())
        end = _code_span_end(lines, index, position, token.group())
        if end is None:
            output.append(token.group())
            continue
        if end[0] != index:
            output.append(line[start:])
            return commented, end
        output.append(line[start:end[1]])
        position = end[1]
    return commented, None


def _mask_html_comments(body: str) -> str:
    lines = body.splitlines(keepends=True)
    output: list[str] = []
    fenced: tuple[str, int, int] | None = None
    list_indents: list[int] = []
    code_end: tuple[int, int] | None = None
    commented = False
    for index, line in enumerate(lines):
        position = 0
        if code_end is not None:
            if index < code_end[0]:
                output.append(line)
                continue
            position = code_end[1]
            output.append(line[:position])
            code_end = None
        if fenced is not None:
            consumed, fenced = _consume_fenced_line(line, fenced)
            if consumed:
                output.append(line)
                continue
        if not commented and not position:
            fenced = _opening_fence(line, list_indents)
            if fenced is not None:
                output.append(line)
                continue
        commented, code_end = _mask_line_comments(lines, index, position, commented, output)
    return "".join(output)


def _document_lines(body: str) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    fenced: tuple[str, int, int] | None = None
    list_indents: list[int] = []
    offset = 0
    for line in body.splitlines(keepends=True):
        start = offset
        offset += len(line)
        if fenced is not None:
            consumed, fenced = _consume_fenced_line(line, fenced)
            if consumed:
                continue
        fenced = _opening_fence(line, list_indents)
        if fenced is None:
            out.append((start, line.rstrip("\r\n")))
    return out


def parse_sections(body: str) -> tuple[dict[str, str], set[str]]:
    body = _mask_html_comments(body)
    headings: list[tuple[int, int, str]] = []
    for offset, line in _document_lines(body):
        if not line.startswith("## "):
            continue
        heading = line[3:].strip()
        if heading:
            headings.append((offset, offset + len(line), normalize_heading(heading)))

    sections: dict[str, str] = {}
    duplicates: set[str] = set()
    for index, (_, heading_end, key) in enumerate(headings):
        end = headings[index + 1][0] if index + 1 < len(headings) else len(body)
        value = body[heading_end:end].strip()
        if key in sections:
            duplicates.add(key)
        else:
            sections[key] = value
    return sections, duplicates


def meaningful_length(text: str) -> int:
    text = re.sub(r"(?m)^\s*[-*+]\s*", "", text)
    return len(" ".join(text.split()))


def _mapping(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def load_config_document(raw: str | None) -> dict:
    config = {
        **DEFAULT,
        "required_sections": list(DEFAULT["required_sections"]),
        "minimum_section_characters": dict(DEFAULT["minimum_section_characters"]),
        "title_types": list(DEFAULT["title_types"]),
    }
    if raw is None:
        return config
    supplied = _mapping(json.loads(raw), "PR contract config")
    if supplied.get("schema_version") != 1:
        raise ValueError("unsupported PR contract schema_version")
    unknown = set(supplied) - set(DEFAULT)
    if unknown:
        raise ValueError("unknown PR contract keys: " + ", ".join(sorted(unknown)))
    if "minimum_section_characters" in supplied:
        minimums = _mapping(supplied["minimum_section_characters"], "minimum_section_characters")
        config["minimum_section_characters"].update(minimums)
    for key in (
        "required_sections",
        "maximum_body_characters",
        "title_types",
        "minimum_title_subject_characters",
    ):
        if key in supplied:
            config[key] = supplied[key]
    if not isinstance(config["required_sections"], list) or not all(
        isinstance(item, str) and item.strip() for item in config["required_sections"]
    ):
        raise ValueError("required_sections must be a non-empty-string array")
    if not isinstance(config["title_types"], list) or not all(
        isinstance(item, str) and item and item.isascii() and item.replace("-", "").isalnum()
        for item in config["title_types"]
    ):
        raise ValueError("title_types must contain simple ASCII identifiers")
    return config


def _minimums(config: dict) -> dict[str, int]:
    return {
        normalize_heading(str(key)): int(value)
        for key, value in config["minimum_section_characters"].items()
    }


def _valid_title(title: str, config: dict) -> bool:
    prefix, separator, subject = title.strip().partition(": ")
    if not separator or len(subject.strip()) < int(config["minimum_title_subject_characters"]):
        return False
    if "(" in prefix:
        if not prefix.endswith(")") or prefix.count("(") != 1 or prefix.count(")") != 1:
            return False
        kind, scope = prefix[:-1].split("(", 1)
        allowed = set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        if not scope or any(char not in allowed for char in scope):
            return False
    else:
        kind = prefix
    return kind in set(config["title_types"])


def validate(title: str, body: str, config: dict) -> list[str]:
    errors: list[str] = []
    if len(body) > int(config["maximum_body_characters"]):
        errors.append(
            f"PR body is {len(body)} characters; maximum is {config['maximum_body_characters']}"
        )
    if not _valid_title(title, config):
        errors.append("PR title does not match the configured deterministic structure")

    sections, duplicates = parse_sections(body)
    minimums = _minimums(config)
    for heading in config["required_sections"]:
        key = normalize_heading(heading)
        if key in duplicates:
            errors.append(f"duplicate required section: ## {heading}")
        if key not in sections:
            errors.append(f"missing required section: ## {heading}")
            continue
        minimum = minimums.get(key, 1)
        size = meaningful_length(sections[key])
        if size < minimum:
            errors.append(
                f"section ## {heading} has {size} meaningful characters; minimum is {minimum}"
            )
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True)
    parser.add_argument("--config-json")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    body = sys.stdin.read()
    try:
        config = load_config_document(args.config_json)
    except (json.JSONDecodeError, ValueError, TypeError) as exc:
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
