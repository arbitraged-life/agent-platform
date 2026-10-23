"""Offline tests for the Q-first PR review snapshot. No GitHub token required."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import json
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / "skills/q-first-pr-review/scripts/triage.py"
spec = importlib.util.spec_from_file_location("q_first_pr_review", SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Unable to load Q-first helper: {SCRIPT}")
q_first = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q_first)


def comment(login, body="", cid=1, association="OWNER"):
    return {"databaseId": cid, "author": {"login": login}, "authorAssociation": association,
            "body": body, "createdAt": "2026-10-22T00:00:00Z"}


def thread(*comments, resolved=False, outdated=False):
    return {"id": "t1", "path": "src/example.py", "line": 4,
            "isResolved": resolved, "isOutdated": outdated,
            "comments": {"pageInfo": {"hasNextPage": False}, "nodes": list(comments)}}


def pr(sha="abc", review_sha="abc", reviewed=True):
    return {"number": 4, "state": "OPEN", "isDraft": False, "url": "https://github.com/o/r/pull/4",
            "headRefOid": sha,
            "reviews": {"nodes": ([{"author": {"login": "amazon-q-developer"},
                                    "submittedAt": "2026-10-22T00:00:00Z", "commit": {"oid": review_sha}, "body": ""}]
                                  if reviewed else [])}}


class QFirstTests(unittest.TestCase):
    def test_q_review_pending_and_no_finding(self):
        result = q_first.classify(pr(reviewed=False), [], "o/r")
        self.assertFalse(result["q_review_observed"])
        self.assertEqual(result["findings"], [])
        self.assertTrue(q_first.classify(pr(), [], "o/r")["q_review_observed"])

    def test_active_only_and_mismatched_head(self):
        result = q_first.classify(pr(sha="new", review_sha="old"), [
            thread(comment("amazon-q-developer", "Fix bug ```suggestion\nx\n```")),
            thread(comment("amazon-q-developer", "Old"), outdated=True),
            thread(comment("amazon-q-developer", "Closed"), resolved=True),
            thread(comment("human", "Please fix")),
        ], "o/r")
        self.assertEqual(result["active_q_findings"], 1)
        self.assertEqual(result["resolved_or_outdated_q_findings"], 2)
        self.assertEqual(result["findings"][0]["status"], "needs_validation")
        self.assertTrue(result["findings"][0]["has_suggested_patch"])
        self.assertFalse(result["q_review_covers_head"])

    def test_request_reply_does_not_prove_commit(self):
        result = q_first.classify(pr(), [thread(
            comment("amazon-q-developer", "Fix the parser"),
            comment("arbitraged-life", "/q fix it make the change"),
            comment("amazon-q-developer", "Here is a patch; I cannot commit"),
        )], "o/r")
        self.assertEqual(result["findings"][0]["status"], "q_replied_verify_code")
        self.assertEqual(result["q_replied_needs_code_verification"], 1)
        self.assertEqual(result["head_sha"], "abc")

    def test_dedupe_pending_q_request(self):
        result = q_first.classify(pr(), [thread(
            comment("amazon-q-developer[bot]", "Potential bug"),
            comment("arbitraged-life", "/q propose fix"),
        )], "o/r")
        self.assertEqual(result["awaiting_q_reply"], 1)
        self.assertEqual(result["needs_validation"], 0)

    def test_embedded_q_text_is_not_an_issued_command(self):
        result = q_first.classify(pr(), [thread(
            comment("amazon-q-developer", "Potential bug"),
            comment("arbitraged-life", "Thanks, but /q is only illustrative"),
        )], "o/r")
        self.assertEqual(result["needs_validation"], 1)

    def test_review_body_is_exposed_without_claiming_an_verified_finding(self):
        record = pr()
        record["reviews"]["nodes"][0]["body"] = "Review summary: check race conditions."
        result = q_first.classify(record, [], "o/r")
        self.assertEqual(result["q_review_body_count"], 1)
        self.assertIn("race conditions", result["q_review_bodies_unverified"][0]["body_excerpt"])
        self.assertEqual(result["active_q_findings"], 0)

    def test_truncated_history_with_no_visible_q_is_unknown(self):
        record = pr(reviewed=False)
        record["reviews"]["pageInfo"] = {"hasPreviousPage": True}
        result = q_first.classify(record, [], "o/r")
        self.assertIsNone(result["q_review_observed"])
        self.assertTrue(result["review_history_truncated"])

    def test_review_command_in_thread_does_not_count_as_pending(self):
        result = q_first.classify(pr(), [thread(
            comment("amazon-q-developer", "Potential issue"),
            comment("arbitraged-life", "/q review"),
        )], "o/r")
        self.assertEqual(result["needs_validation"], 1)
        self.assertEqual(result["awaiting_q_reply"], 0)

    def test_unprivileged_command_does_not_count_as_pending(self):
        result = q_first.classify(pr(), [thread(
            comment("amazon-q-developer", "Potential issue"),
            comment("external-user", "/q fix this", association="CONTRIBUTOR"),
        )], "o/r")
        self.assertEqual(result["needs_validation"], 1)

    def test_graphql_errors_fail_closed_without_logging_details(self):
        def fake_run(cmd, **kwargs):
            payload = {"errors": [{"message": "private API information"}]}
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")
        with patch.object(q_first.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(ValueError, "GitHub GraphQL returned errors") as error:
                q_first.review_snapshot("o/r", 4)
        self.assertNotIn("private API information", str(error.exception))

    def test_reader_is_read_only_and_paginates(self):
        calls = []
        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            self.assertEqual(cmd[:3], ["gh", "api", "graphql"])
            self.assertTrue(q_first.QUERY.lstrip().startswith("query("))
            self.assertNotIn("mutation(", q_first.QUERY.casefold())
            self.assertIs(kwargs.get("shell"), False)
            self.assertTrue(all(isinstance(arg, str) for arg in cmd))
            cursor = any("after=NEXT" == c for c in cmd)
            response = {"data": {"repository": {"pullRequest": {
                **pr(),
                "reviewThreads": {"nodes": [thread(comment("amazon-q-developer", "Bug"))] if not cursor else [],
                                  "pageInfo": {"hasNextPage": not cursor,
                                               "endCursor": "NEXT" if not cursor else None}},
            }}}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(response), stderr="")
        with patch.object(q_first.subprocess, "run", side_effect=fake_run):
            snapshot, threads = q_first.review_snapshot("o/r", 4)
        self.assertEqual(len(calls), 2)
        self.assertEqual(snapshot["number"], 4)
        self.assertEqual(len(threads), 1)

    def test_pr_head_change_between_pages_fails_closed(self):
        calls = []
        def fake_run(cmd, **kwargs):
            calls.append(cmd)
            second = "after=NEXT" in cmd
            record = pr(sha="changed" if second else "original")
            record["reviewThreads"] = {
                "nodes": [],
                "pageInfo": {"hasNextPage": not second,
                             "endCursor": "NEXT" if not second else None},
            }
            response = {"data": {"repository": {"pullRequest": record}}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(response), stderr="")
        with patch.object(q_first.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(ValueError, "PR head moved"):
                q_first.review_snapshot("o/r", 4)
        self.assertEqual(len(calls), 2)

    def test_unpaged_long_thread_fails_closed(self):
        def fake_run(cmd, **kwargs):
            record = thread(comment("amazon-q-developer", "Bug"))
            record["comments"]["pageInfo"]["hasNextPage"] = True
            data = {"data": {"repository": {"pullRequest": {
                **pr(), "reviewThreads": {"nodes": [record], "pageInfo": {"hasNextPage": False, "endCursor": None}}
            }}}}
            return SimpleNamespace(returncode=0, stdout=json.dumps(data), stderr="")
        with patch.object(q_first.subprocess, "run", side_effect=fake_run):
            with self.assertRaisesRegex(ValueError, "cannot safely deduplicate"):
                q_first.review_snapshot("o/r", 4)

    def test_truncated_review_history_never_claims_current_head(self):
        record = pr()
        record["reviews"]["pageInfo"] = {"hasPreviousPage": True}
        result = q_first.classify(record, [], "o/r")
        self.assertTrue(result["review_history_truncated"])
        self.assertTrue(result["q_review_observed"])
        self.assertIsNone(result["q_review_sha"])
        self.assertIsNone(result["q_review_covers_head"])

    def test_rejects_invalid_repository(self):
        with self.assertRaisesRegex(ValueError, "owner/name"):
            q_first.review_snapshot("owner/repo;evil", 3)
        with self.assertRaisesRegex(ValueError, "owner/name"):
            q_first.review_snapshot("owner.corp/repo", 3)


if __name__ == "__main__":
    unittest.main()
