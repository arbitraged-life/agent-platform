#!/usr/bin/env python3
"""Read-only Amazon Q review snapshot for an existing GitHub pull request.

This program never invokes Amazon Q, writes comments, changes branches, or
starts a runner. It leaves finding validity to the PR owner/coding agent.
"""

import argparse
import json
import re
import subprocess
import sys

Q_AUTHORS = frozenset({"amazon-q-developer", "amazon-q-developer[bot]"})
REPO_PATTERN = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
PAGE_LIMIT = 20

QUERY = """query($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) {
    pullRequest(number:$number) {
      number state isDraft url headRefOid baseRefName
      reviews(last:100) { nodes { author { login } submittedAt commit { oid } } }
      reviewThreads(first:100,after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first:100) {
            pageInfo { hasNextPage }
            nodes { databaseId author { login } body createdAt }
          }
        }
      }
    }
  }
}"""


def is_q(login):
    return isinstance(login, str) and login.lower() in Q_AUTHORS


def review_snapshot(repo, number):
    if not REPO_PATTERN.fullmatch(repo):
        raise ValueError("Repository must be owner/name")
    if number < 1:
        raise ValueError("PR number must be positive")
    owner, name = repo.split("/", 1)
    cursor = None
    threads = []
    pr = None
    for _ in range(PAGE_LIMIT):
        command = ["gh", "api", "graphql", "-f", "query=" + QUERY,
                   "-f", "owner=" + owner, "-f", "name=" + name,
                   "-F", "number=" + str(number)]
        if cursor:
            command.extend(["-f", "after=" + cursor])
        result = subprocess.run(command, text=True, capture_output=True,
                                check=True, timeout=45)
        payload = json.loads(result.stdout)
        # Fail closed without printing GraphQL errors that may contain private metadata.
        if payload.get("errors"):
            raise ValueError("GitHub GraphQL returned errors")
        found = ((payload.get("data") or {}).get("repository") or {}).get("pullRequest")
        if not found:
            raise ValueError("PR not found or inaccessible")
        if pr and found["headRefOid"] != pr["headRefOid"]:
            raise ValueError("PR head moved during paginated review read; retry once")
        pr = found
        connection = found["reviewThreads"]
        for thread in connection["nodes"]:
            if (thread.get("comments") or {}).get("pageInfo", {}).get("hasNextPage"):
                raise ValueError("Thread has more than 100 replies; cannot safely deduplicate")
            threads.append(thread)
        page = connection["pageInfo"]
        if not page["hasNextPage"]:
            return pr, threads
        cursor = page.get("endCursor")
        if not cursor:
            raise ValueError("Missing GitHub pagination cursor")
    raise ValueError("Review exceeds bounded pagination limit")


def classify(pr, threads, repo):
    """Do not infer finding validity or implemented code solely from comments."""
    q_reviews = [r for r in (pr.get("reviews") or {}).get("nodes", [])
                 if is_q((r.get("author") or {}).get("login"))]
    results = []
    skipped = 0
    for thread in threads:
        comments = (thread.get("comments") or {}).get("nodes") or []
        if not comments or not is_q((comments[0].get("author") or {}).get("login")):
            continue
        if thread.get("isResolved") or thread.get("isOutdated"):
            skipped += 1
            continue
        last_request = -1
        for i, comment in enumerate(comments):
            body = comment.get("body") or ""
            login = (comment.get("author") or {}).get("login")
            # GitHub Amazon Q slash commands must lead the comment, after whitespace.
            if not is_q(login) and re.match(r"\s*/q(?:\s|$)", body, flags=re.I):
                last_request = i
        if last_request < 0:
            state = "needs_validation"
        elif any(is_q((c.get("author") or {}).get("login")) for c in comments[last_request + 1:]):
            state = "q_replied_verify_code"
        else:
            state = "awaiting_q_reply"
        body = comments[0].get("body") or ""
        results.append({
            "thread_id": thread.get("id"),
            "comment_id": comments[0].get("databaseId"),
            "path": thread.get("path"),
            "line": thread.get("line"),
            "status": state,
            "has_suggested_patch": any("```suggestion" in (c.get("body") or "") for c in comments),
            "review_excerpt": body[:320],
        })
    most_recent_review = max(q_reviews, key=lambda r: r.get("submittedAt") or "", default=None)
    reviewed_sha = ((most_recent_review or {}).get("commit") or {}).get("oid")
    head = pr["headRefOid"]
    return {
        "repository": repo,
        "pr": pr["number"],
        "url": pr["url"],
        "head_sha": head,
        "state": pr["state"],
        "draft": pr["isDraft"],
        "q_review_observed": bool(q_reviews or results or skipped),
        "q_review_sha": reviewed_sha,
        "q_review_covers_head": (reviewed_sha == head if reviewed_sha else None),
        "active_q_findings": len(results),
        "resolved_or_outdated_q_findings": skipped,
        "needs_validation": sum(x["status"] == "needs_validation" for x in results),
        "awaiting_q_reply": sum(x["status"] == "awaiting_q_reply" for x in results),
        "q_replied_needs_code_verification": sum(x["status"] == "q_replied_verify_code" for x in results),
        "findings": results,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="GitHub owner/repo")
    parser.add_argument("--pr", type=int, required=True)
    args = parser.parse_args(argv)
    try:
        pr, threads = review_snapshot(args.repo, args.pr)
        print(json.dumps(classify(pr, threads, args.repo), separators=(",", ":")))
    except (ValueError, OSError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired, json.JSONDecodeError):
        print("Q-first review snapshot unavailable", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
