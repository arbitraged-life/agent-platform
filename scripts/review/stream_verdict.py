#!/usr/bin/env python3
"""Stream tool-free OMP JSONL and stop as soon as a final assistant
`text_end` contains a parseable review verdict. Fail closed otherwise.

A reader thread drains stdout into a queue so the deadline is enforced by the
queue's own `get(timeout=...)`, not by a blocking `readline()` on the main
thread -- a plain `readline()` loop cannot time out while the child is alive
but silent.

Exit codes: 0 = verdict found, printed as the sole stdout line.
            124 = timed out with no verdict.
            125 = process exited on its own with no verdict.
"""
import json
import queue
import subprocess
import sys
import threading
import time


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
        evt = json.loads(line)
    except json.JSONDecodeError:
        continue
    content = None
    ev = evt.get("assistantMessageEvent")
    if evt.get("type") == "message_update" and ev and ev.get("type") == "text_end":
        content = ev.get("content")
    if isinstance(content, str):
        try:
            candidate = json.loads(content)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict) and candidate.get("verdict") in ("PASS", "FAIL"):
            verdict = candidate
            break

if proc.poll() is None:
    proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass

if verdict is not None:
    print(json.dumps(verdict))
    sys.exit(0)
if stdout_closed:
    sys.exit(125)
sys.exit(124)
