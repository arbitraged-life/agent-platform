#!/usr/bin/env bash
# Tool-free adversarial review gate for pushes. Rejects absent or malformed
# verdicts; only the configured OMP reviewer can inspect the pushed diff.
set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

REVIEW_MODEL="${ADVERSARIAL_REVIEW_MODEL:-github-copilot/gpt-5.3-codex:high}"
REVIEW_TIMEOUT="${ADVERSARIAL_REVIEW_TIMEOUT:-300}"
REVIEW_BACKEND="${ADVERSARIAL_REVIEW_BACKEND:-omp}"
DEFAULT_BASE="${ADVERSARIAL_REVIEW_BASE:-main}"
# Reasoning effort for the review call. Defaults to high (matching the
# configured reviewer role's :high suffix) rather than off: real omp -p
# calls timed out in testing regardless of thinking level, so dropping
# effort bought no reliability and only weakened the review itself.
REVIEW_THINKING="${ADVERSARIAL_REVIEW_THINKING:-high}"

if [ "$REVIEW_BACKEND" != "omp" ]; then
  echo "adversarial-review: unsupported backend; failing closed." >&2
  exit 1
fi
review_cmd=(omp -p --mode json --thinking="$REVIEW_THINKING" --model "$REVIEW_MODEL" --no-tools)
if ! command -v "${review_cmd[0]}" >/dev/null 2>&1; then
  echo "adversarial-review: reviewer CLI unavailable; failing closed." >&2
  exit 1
fi

any_pushed=0
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "${local_ref:-}" ] && continue
  # Deleting a ref: nothing to review.
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch: diff against merge-base with the default base branch.
    if ! base="$(git merge-base "$DEFAULT_BASE" "$local_sha" 2>/dev/null)"; then
      echo "adversarial-review: cannot compute merge-base with '$DEFAULT_BASE' for $local_ref; failing closed." >&2
      echo "Set ADVERSARIAL_REVIEW_BASE to a valid ref." >&2
      exit 1
    fi
  else
    base="$remote_sha"
  fi
  diff_range="${base}..${local_sha}"
  if ! diff_text="$(git diff "$diff_range" -- . 2>&1)"; then
    echo "adversarial-review: 'git diff $diff_range' failed; failing closed." >&2
    echo "$diff_text" >&2
    exit 1
  fi
  if [ -z "$diff_text" ]; then
    echo "adversarial-review: no changes in $diff_range, nothing to review." >&2
    continue
  fi
  any_pushed=1

  prompt=$(printf '%s\n\n%s\n```diff\n%s\n```\n\n%s' \
    "Review this diff for correctness, security, and over-engineering (do not run tests/formatters)." \
    "Diff for $diff_range:" \
    "$diff_text" \
    'Reply with ONLY a single JSON object, no prose, no markdown fences, no tool calls: {"verdict":"PASS"|"FAIL","findings":["..."]}. Use FAIL only for real correctness/security defects, not style.')

  if ! prompt_file="$(umask 077; mktemp)"; then
    echo "adversarial-review: cannot create private review prompt; failing closed." >&2
    exit 1
  fi
  trap 'rm -f "$prompt_file"' EXIT
  if ! printf '%s' "$prompt" > "$prompt_file"; then
    echo "adversarial-review: cannot write private review prompt; failing closed." >&2
    exit 1
  fi
  # OMP expands @file into message content before the no-tools model turn;
  # a tool-free CLI smoke reproduced a random marker present only in the file.
  verdict_json=$(python3 "$REPO_ROOT/scripts/review/stream_verdict.py" "$REVIEW_TIMEOUT" "${review_cmd[@]}" "@$prompt_file" < /dev/null 2>/dev/null)
  rc=$?
  if ! rm -f "$prompt_file"; then
    echo "adversarial-review: cannot remove private review prompt; failing closed." >&2
    exit 1
  fi
  trap - EXIT
  if [ "$rc" -eq 124 ]; then
    echo "adversarial-review: timed out after ${REVIEW_TIMEOUT}s reviewing $diff_range with no verdict; failing closed." >&2
    exit 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "adversarial-review: no parseable verdict (exit $rc) reviewing $diff_range; failing closed." >&2
    exit 1
  fi

  verdict=$(printf '%s' "$verdict_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verdict"])' 2>/dev/null)
  if [ -z "$verdict" ]; then
    echo "adversarial-review: malformed verdict JSON for $diff_range; failing closed." >&2
    exit 1
  fi
  if [ "$verdict" != "PASS" ]; then
    echo "adversarial-review: FAIL for $diff_range" >&2
    printf '%s' "$verdict_json" | python3 -c 'import json,sys; [print("  -", f) for f in json.load(sys.stdin).get("findings", [])]' >&2
    exit 1
  fi
  echo "adversarial-review: PASS for $diff_range"
done

exit 0
