#!/usr/bin/env python3
"""Behavioral tests for the reusable merge gate evidence policy."""

import unittest

from unittest.mock import patch
import merge_gate

SHA = "a" * 40
APP_ID = 12345
PR_NUMBER = 42
PIPELINE_CI = "550e8400-e29b-41d4-a716-446655440010"
WORKFLOW_CI = "550e8400-e29b-41d4-a716-446655440011"
CORRELATION_CI = "550e8400-e29b-41d4-a716-446655440012"
PIPELINE_INTEGRATION = "550e8400-e29b-41d4-a716-446655440020"
WORKFLOW_INTEGRATION = "550e8400-e29b-41d4-a716-446655440021"
CORRELATION_INTEGRATION = "550e8400-e29b-41d4-a716-446655440022"


def action(workflow="ci.yml", *, sha=SHA, status="completed", conclusion="success", run_id=10):
    return {
        "workflow": workflow,
        "head_sha": sha,
        "status": status,
        "conclusion": conclusion,
        "run_id": run_id,
        "run_attempt": 1,
    }


def provider(workflow="ci", *, sha=SHA, app_id=APP_ID, status="completed", conclusion="success", external_id=f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-42:{CORRELATION_CI}"):
    return {
        "name": f"CircleCI / {workflow}",
        "head_sha": sha,
        "app_id": app_id,
        "status": status,
        "conclusion": conclusion,
        "external_id": external_id,
    }


class MergeGatePolicyTests(unittest.TestCase):
    def test_actions_only_default_accepts_named_current_success_and_ignores_advisory_failure(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            required_actions=["ci.yml"],
            advisory_actions=["security.yml"],
            action_runs=[action(), action("security.yml", conclusion="failure", run_id=11)],
        )
        self.assertTrue(result.allowed)
        self.assertEqual(result.source, "actions")

    def test_provider_requires_exact_named_checks_and_receipts_for_current_pr_head(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            pr_number=PR_NUMBER,
            required_actions=[],
            advisory_actions=[],
            action_runs=[],
            provider_enabled=True,
            trusted_publisher_app_id=APP_ID,
            required_provider_workflows=["ci", "integration"],
            provider_checks=[
                provider(),
                provider("integration", external_id=f"{PIPELINE_INTEGRATION}:{WORKFLOW_INTEGRATION}:attempt-3:pr-42:{CORRELATION_CI}"),
            ],
        )
        self.assertTrue(result.allowed)
        self.assertEqual(result.source, "provider")

    def test_independent_provider_workflow_receipts_can_have_distinct_pipeline_attempts(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            pr_number=PR_NUMBER,
            required_actions=[],
            advisory_actions=[],
            action_runs=[],
            provider_enabled=True,
            trusted_publisher_app_id=APP_ID,
            required_provider_workflows=["ci", "integration"],
            provider_checks=[
                provider(),
                provider("integration", external_id=f"{PIPELINE_INTEGRATION}:{WORKFLOW_INTEGRATION}:attempt-4:pr-42:{CORRELATION_INTEGRATION}"),
            ],
        )
        self.assertTrue(result.allowed)
        self.assertEqual(result.source, "provider")

    def test_failing_or_stale_required_provider_workflow_denies_merge(self):
        valid = provider()
        failures = [
            provider("integration", conclusion="failure", external_id=f"{PIPELINE_INTEGRATION}:{WORKFLOW_INTEGRATION}:attempt-4:pr-42:{CORRELATION_INTEGRATION}"),
            provider("integration", sha="b" * 40, external_id=f"{PIPELINE_INTEGRATION}:{WORKFLOW_INTEGRATION}:attempt-4:pr-42:{CORRELATION_INTEGRATION}"),
        ]
        for check in failures:
            with self.subTest(conclusion=check["conclusion"], sha=check["head_sha"]):
                result = merge_gate.evaluate_evidence(
                    head_sha=SHA,
                    pr_number=PR_NUMBER,
                    required_actions=[],
                    advisory_actions=[],
                    action_runs=[],
                    provider_enabled=True,
                    trusted_publisher_app_id=APP_ID,
                    required_provider_workflows=["ci", "integration"],
                    provider_checks=[valid, check],
                )
                self.assertFalse(result.allowed)

    def test_one_failing_required_workflow_denies_merge(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            required_actions=["ci.yml", "release.yml"],
            advisory_actions=[],
            action_runs=[action(), action("release.yml", conclusion="failure", run_id=12)],
        )
        self.assertFalse(result.allowed)
        self.assertIn("release.yml", result.reason)

    def test_untrusted_green_status_cannot_substitute_for_provider_check(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            pr_number=PR_NUMBER,
            required_actions=[],
            advisory_actions=[],
            action_runs=[],
            provider_enabled=True,
            trusted_publisher_app_id=APP_ID,
            required_provider_workflows=["ci"],
            provider_checks=[provider(app_id=APP_ID + 1)],
        )
        self.assertFalse(result.allowed)
        self.assertIn("publisher", result.reason)

    def test_provider_receipt_must_correlate_to_current_pr_number(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            pr_number=PR_NUMBER,
            required_actions=[],
            advisory_actions=[],
            action_runs=[],
            provider_enabled=True,
            trusted_publisher_app_id=APP_ID,
            required_provider_workflows=["ci"],
            provider_checks=[provider(external_id=f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-43:{CORRELATION_CI}")],
        )
        self.assertFalse(result.allowed)
        self.assertIn("PR", result.reason)


    def test_newer_pr_commit_rejects_old_success(self):
        result = merge_gate.evaluate_evidence(
            head_sha="b" * 40,
            required_actions=["ci.yml"],
            advisory_actions=[],
            action_runs=[action(sha=SHA)],
        )
        self.assertFalse(result.allowed)
        self.assertIn("head SHA", result.reason)

    def test_duplicate_success_callbacks_are_ambiguous_and_denied(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            required_actions=["ci.yml"],
            advisory_actions=[],
            action_runs=[action(run_id=10), action(run_id=11)],
        )
        self.assertFalse(result.allowed)
        self.assertIn("ambiguous", result.reason)

    def test_unavailable_provider_is_not_treated_as_success(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            pr_number=PR_NUMBER,
            required_actions=[],
            advisory_actions=[],
            action_runs=[],
            provider_enabled=True,
            trusted_publisher_app_id=APP_ID,
            required_provider_workflows=["ci"],
            provider_checks=[],
        )
        self.assertFalse(result.allowed)
        self.assertIn("missing", result.reason)

    def test_pending_skipped_cancelled_and_malformed_provider_receipts_fail_closed(self):
        valid_receipt = f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-42:{CORRELATION_CI}"
        for status, conclusion, external_id in [
            ("in_progress", None, valid_receipt),
            ("completed", "skipped", valid_receipt),
            ("completed", "cancelled", valid_receipt),
            ("completed", "success", ""),
            ("completed", "success", f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-0:pr-42:{CORRELATION_CI}"),
            ("completed", "success", f"1:{WORKFLOW_CI}:attempt-3:pr-42:{CORRELATION_CI}"),
            ("completed", "success", f"{PIPELINE_CI}:2:attempt-3:pr-42:{CORRELATION_CI}"),
            ("completed", "success", f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-42:550e8400-e29b-71d4-a716-446655440000"),
            ("completed", "success", f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-42:550e8400-e29b-f1d4-a716-446655440000"),
        ]:
            with self.subTest(status=status, conclusion=conclusion, external_id=external_id):
                result = merge_gate.evaluate_evidence(
                    head_sha=SHA,
                    pr_number=PR_NUMBER,
                    required_actions=[],
                    advisory_actions=[],
                    action_runs=[],
                    provider_enabled=True,
                    trusted_publisher_app_id=APP_ID,
                    required_provider_workflows=["ci"],
                    provider_checks=[provider(status=status, conclusion=conclusion, external_id=external_id)],
                )
                self.assertFalse(result.allowed)

    def test_provider_opt_in_without_publisher_or_required_set_is_invalid(self):
        result = merge_gate.evaluate_evidence(
            head_sha=SHA,
            required_actions=[],
            advisory_actions=[],
            action_runs=[],
            provider_enabled=True,
            trusted_publisher_app_id=None,
            required_provider_workflows=[],
            provider_checks=[],
        )
        self.assertFalse(result.allowed)
        self.assertIn("configuration", result.reason)

    def test_truncated_provider_check_page_is_rejected(self):
        response = {"total_count": 101, "check_runs": [{}] * 50}
        with patch.object(merge_gate, "_gh_json", return_value=response):
            with self.assertRaisesRegex(ValueError, "truncated"):
                merge_gate._get_provider_checks("owner/repo", SHA)

    def test_provider_checks_include_every_page_before_allowing_a_required_check(self):
        pages = [
            {"total_count": 101, "check_runs": [{"name": "unrelated"}] * 100},
            {"total_count": 101, "check_runs": [{
                "name": "CircleCI / ci", "head_sha": SHA, "app": {"id": APP_ID},
                "status": "completed", "conclusion": "failure",
                "external_id": f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-42:{CORRELATION_CI}",
            }]},
        ]
        with patch.object(merge_gate, "_gh_json", side_effect=pages * 2) as request:
            checks = merge_gate._get_provider_checks("owner/repo", SHA)
        self.assertEqual(request.call_count, 4)
        result = merge_gate.evaluate_evidence(
            head_sha=SHA, pr_number=PR_NUMBER, required_actions=[], advisory_actions=[],
            action_runs=[], provider_enabled=True, trusted_publisher_app_id=APP_ID,
            required_provider_workflows=["ci"], provider_checks=checks,
        )
        self.assertFalse(result.allowed)
        self.assertIn("failure", result.reason)

    def test_provider_check_pagination_rejects_changed_snapshot(self):
        pages = [
            {"total_count": 101, "check_runs": [{"name": "unrelated"}] * 100},
            {"total_count": 102, "check_runs": [{"name": "CircleCI / ci"}]},
        ]
        with patch.object(merge_gate, "_gh_json", side_effect=pages):
            with self.assertRaisesRegex(ValueError, "changed"):
                merge_gate._get_provider_checks("owner/repo", SHA)

    def test_provider_check_pagination_rejects_same_count_page_replacement(self):
        success = {
            "name": "CircleCI / ci", "head_sha": SHA, "app": {"id": APP_ID},
            "status": "completed", "conclusion": "success",
            "external_id": f"{PIPELINE_CI}:{WORKFLOW_CI}:attempt-3:pr-42:{CORRELATION_CI}",
        }
        pages = [
            {"total_count": 101, "check_runs": [success] + [{"name": "unrelated"}] * 99},
            {"total_count": 101, "check_runs": [{"name": "other"}]},
            {"total_count": 101, "check_runs": [success, {**success, "conclusion": "failure"}] + [{"name": "unrelated"}] * 98},
            {"total_count": 101, "check_runs": [{"name": "other"}]},
        ]
        with patch.object(merge_gate, "_gh_json", side_effect=pages):
            with self.assertRaisesRegex(ValueError, "changed"):
                merge_gate._get_provider_checks("owner/repo", SHA)

    def test_provider_check_pagination_rejects_over_bound_instead_of_skipping_checks(self):
        with patch.object(merge_gate, "_gh_json", return_value={"total_count": 1001, "check_runs": [{}] * 100}) as request:
            with self.assertRaisesRegex(ValueError, "bound"):
                merge_gate._get_provider_checks("owner/repo", SHA)
        request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
