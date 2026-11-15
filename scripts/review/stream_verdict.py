#!/usr/bin/env python3
"""Stream tool-free OMP JSONL and inspect the completed assistant `message_end`.
Fail closed on any invalid completed response or malformed event.

A reader thread drains stdout into a queue so the deadline is enforced by the
queue's own `get(timeout=...)`, not by a blocking `readline()` on the main
thread -- a plain `readline()` loop cannot time out while the child is alive
but silent.

Exit codes: 0 = valid completed verdict, printed as the sole stdout line.
            124 = timed out without a completed verdict.
            125 = invalid response or process exited without a completed verdict.
"""
import json
import queue
import subprocess
import sys
import threading
import time


def unique_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field")
        result[key] = value
    return result


def completed_verdict(message: object) -> dict | None:
    if not isinstance(message, dict) or message.get("stopReason") != "stop":
        return None
    if "errorMessage" in message and message["errorMessage"] is not None:
        return None
    content = message.get("content")
    if not isinstance(content, list):
        return None
    text = []
    for block in content:
        if not isinstance(block, dict):
            return None
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            text.append(block["text"])
        elif block.get("type") == "thinking" and isinstance(block.get("thinking"), str):
            continue
        elif block.get("type") == "redactedThinking" and isinstance(block.get("data"), str):
            continue
        else:
            return None
    if not text:
        return None
    try:
        candidate = json.loads("".join(text), object_pairs_hook=unique_fields)
    except (ValueError, TypeError):
        return None
    return candidate if valid_verdict(candidate) else None


def valid_verdict(candidate: object) -> bool:
    if not isinstance(candidate, dict) or candidate.keys() != {"verdict", "findings"}:
        return False
    findings = candidate["findings"]
    if not isinstance(findings, list) or any(
        not isinstance(finding, str) or not finding.strip() for finding in findings
    ):
        return False
    return (candidate["verdict"] == "PASS" and not findings) or (
        candidate["verdict"] == "FAIL" and bool(findings)
    )


if len(sys.argv) < 3:
    print("usage: stream_verdict.py <timeout_seconds> <cmd> [args...]", file=sys.stderr)
    sys.exit(2)

timeout = float(sys.argv[1])
cmd = sys.argv[2:]

proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
lines: "queue.Queue[str | None]" = queue.Queue()


def _pump() -> None:
    try:
        for line in proc.stdout:
            lines.put(line)
    finally:
        lines.put(None)  # sentinel: stdout closed / process exited


threading.Thread(target=_pump, daemon=True).start()

deadline = time.monotonic() + timeout
verdict = None
invalid_final = False
stdout_closed = False

while time.monotonic() < deadline:
    remaining = deadline - time.monotonic()
    try:
        line = lines.get(timeout=max(0.0, remaining))
    except queue.Empty:
        break
    if line is None:
        stdout_closed = True
        break
    line = line.strip()
    if not line:
        continue
    try:
        evt = json.loads(line, object_pairs_hook=unique_fields)
    except (ValueError, TypeError):
        invalid_final = True
        break
    if not isinstance(evt, dict) or evt.get("type") != "message_end":
        continue
    message = evt.get("message")
    if isinstance(message, dict) and message.get("role") in ("user", "developer", "toolResult"):
        continue
    verdict = completed_verdict(message)
    if verdict is None or message.get("role") != "assistant":
        invalid_final = True
    break

if proc.poll() is None:
    proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass

if invalid_final:
    sys.exit(125)
if verdict is not None:
    print(json.dumps(verdict))
    sys.exit(0)
if stdout_closed:
    sys.exit(125)
sys.exit(124)
