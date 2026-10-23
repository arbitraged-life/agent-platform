#!/usr/bin/env python3
"""Read-only Amazon Q review snapshot for an existing GitHub pull request.

This program never invokes Amazon Q, writes comments, changes branches, or
starts a runner. It leaves finding validity to the PR owner/coding agent.
"""

import argparse
import json
import re
# qlty-ignore(bandit:B404): Required GitHub CLI invocation uses fixed argv, never a shell.
import subprocess
import sys

Q_AUTHORS = frozenset({"amazon-q-developer", "amazon-q-developer[bot]"})
COMMAND_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
REPO_PATTERN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}\Z")
COMMAND_PATTERN = re.compile(r"^\s*/q(?:\s|$)", re.I)
THREAD_REVIEW_PATTERN = re.compile(r"^\s*/q\s+review(?:\s|$)", re.I)
PAGE_LIMIT = 20
REVIEW_BODY_LIMIT = 20

QUERY = """query($owner:String!,$name:String!,$number:Int!,$after:String) {
  repository(owner:$owner,name:$name) {
    pullRequest(number:$number) {
      number state isDraft url headRefOid baseRefName
      reviews(last:100) {
        pageInfo { hasPreviousPage }
        nodes { author { login } submittedAt commit { oid } body }
      }
      reviewThreads(first:100,after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          comments(first:100) {
            pageInfo { hasNextPage }
            nodes { databaseId author { login } authorAssociation body createdAt }
          }
        }
      }
    }
  }
}"""


def is_q(login):
    return isinstance(login, str) and login.lower() in Q_AUTHORS


def _read_pr_page(owner, name, number, cursor):
    # All caller input remains an argv VALUE after a fixed key; no shell interpretation.
    command = ["gh", "api", "graphql", "-f", "query=" + QUERY,
               "-f", "owner=" + owner, "-f", "name=" + name,
               "-F", "number=" + str(number)]
    if cursor:
        command.extend(["-f", "after=" + cursor])
    # qlty-ignore(bandit:B603): A fixed gh executable, explicit argv, and shell=False prevent shell injection.
    # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
    response = subprocess.run(command, shell=False, text=True,
                              capture_output=True, check=True, timeout=45)
    payload = json.loads(response.stdout)
    # Fail closed rather than printing provider errors that may contain private data.
    if payload.get("errors"):
        raise ValueError("GitHub GraphQL returned errors")
    pr = ((payload.get("data") or {}).get("repository") or {}).get("pullRequest")
    if not pr:
        raise ValueError("PR not found or inaccessible")
    return pr


def _append_bounded_threads(connection, collected):
    for thread in connection["nodes"]:
        if (thread.get("comments") or {}).get("pageInfo", {}).get("hasNextPage"):
            raise ValueError("Thread has more than 100 replies; cannot safely deduplicate")
        collected.append(thread)


def review_snapshot(repo, number):
    if not REPO_PATTERN.fullmatch(repo):
        raise ValueError("Repository must be owner/name")
    if number < 1:
        raise ValueError("PR number must be positive")
    owner, name = repo.split("/", 1)
    cursor = None
    head = None
    threads = []
    for _ in range(PAGE_LIMIT):
        pr = _read_pr_page(owner, name, number, cursor)
        if head is not None and pr["headRefOid"] != head:
            raise ValueError("PR head moved during paginated review read; retry once")
        head = pr["headRefOid"]
        connection = pr["reviewThreads"]
        _append_bounded_threads(connection, threads)
        page = connection["pageInfo"]
        if not page["hasNextPage"]:
            return pr, threads
        cursor = page.get("endCursor")
        if not cursor:
            raise ValueError("Missing GitHub pagination cursor")
    raise ValueError("Review exceeds bounded pagination limit")


def _invocable_thread_request(comment):
    """A valid-looking command, not proof that GitHub granted effective Write."""
    login = (comment.get("author") or {}).get("login")
    association = comment.get("authorAssociation")
    body = comment.get("body") or ""
    return (not is_q(login) and association in COMMAND_ASSOCIATIONS
            and bool(COMMAND_PATTERN.match(body))
            and not THREAD_REVIEW_PATTERN.match(body))


def _thread_status(comments):
    requests = [i for i, comment in enumerate(comments)
                if _invocable_thread_request(comment)]
    if not requests:
        return "needs_validation"
    last = requests[-1]
    if any(is_q((c.get("author") or {}).get("login")) for c in comments[last + 1:]):
        return "q_replied_verify_code"
    return "awaiting_q_reply"


def _thread_finding(thread, comments):
    return {
        "thread_id": thread.get("id"),
        "comment_id": comments[0].get("databaseId"),
        "path": thread.get("path"),
        "line": thread.get("line"),
        "status": _thread_status(comments),
        "has_suggested_patch": any("```suggestion" in (c.get("body") or "") for c in comments),
        "review_excerpt": (comments[0].get("body") or "")[:320],
    }


def _review_body_candidate(review):
    body = review.get("body")
    if not isinstance(body, str) or not body.strip():
        return None
    return {
        "submitted_at": review.get("submittedAt"),
        "review_sha": (review.get("commit") or {}).get("oid"),
        "body_excerpt": body.strip()[:500],
    }


def classify(pr, threads, repo):
    """Candidates are not verified code defects, and replies are not commits."""
    reviews = pr.get("reviews") or {}
    truncated = bool((reviews.get("pageInfo") or {}).get("hasPreviousPage"))
    q_reviews = [r for r in reviews.get("nodes", [])
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
        results.append(_thread_finding(thread, comments))
    q_bodies = [_review_body_candidate(review) for review in q_reviews]
    q_bodies = [candidate for candidate in q_bodies if candidate is not None]
    recent = max(q_reviews, key=lambda r: r.get("submittedAt") or "", default=None)
    review_sha = ((recent or {}).get("commit") or {}).get("oid") if not truncated else None
    observed = bool(q_reviews or results or skipped)
    if not observed and truncated:
        observed = None  # Older review history is unknown, not absent.
    return {
        "repository": repo,
        "pr": pr["number"],
        "url": pr["url"],
        "head_sha": pr["headRefOid"],
        "state": pr["state"],
        "draft": pr["isDraft"],
        "q_review_observed": observed,
        "review_history_truncated": truncated,
        "q_review_sha": review_sha,
        "q_review_covers_head": (review_sha == pr["headRefOid"] if review_sha else None),
        "q_review_body_count": len(q_bodies),
        "q_review_bodies_unverified": q_bodies[-REVIEW_BODY_LIMIT:],
        "q_review_body_list_truncated": len(q_bodies) > REVIEW_BODY_LIMIT,
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
            subprocess.TimeoutExpired):
        print("Q-first review snapshot unavailable", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
