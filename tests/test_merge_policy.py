"""Public dependency merge ownership and eligibility contract."""
import json
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]

class MergePolicyTests(unittest.TestCase):
    def setUp(self):
        self.policy = json.loads((ROOT / "renovate.json").read_text())
        self.mergify = yaml.safe_load((ROOT / ".mergify.yml").read_text())

    def test_native_merge_keeps_checks_and_safe_default(self):
        for key, value in {"automerge": False, "automergeType": "pr", "platformAutomerge": True, "automergeStrategy": "squash", "ignoreTests": False}.items():
            self.assertEqual(self.policy.get(key), value, key)
        self.assertIn("config:best-practices", self.policy["extends"])

    def test_only_stable_low_risk_update_classes_are_automatic(self):
        rules = self.policy["packageRules"]
        automatic_types = {kind for rule in rules if rule.get("automerge") is True for kind in rule.get("matchUpdateTypes", [])}
        self.assertEqual(automatic_types, {"minor", "patch", "pin", "pinDigest", "digest", "lockFileMaintenance"})
        for rule in (rule for rule in rules if rule.get("automerge") is True):
            self.assertTrue(rule.get("matchUpdateTypes"))
            self.assertNotIn("major", rule["matchUpdateTypes"])
            if set(rule["matchUpdateTypes"]) & {"minor", "patch"}:
                self.assertEqual(rule.get("matchCurrentVersion"), "!/^0/")
        self.assertTrue(any(r.get("matchCurrentVersion") == "/^0/" and r.get("automerge") is False for r in rules))
        self.assertTrue(any(r.get("matchUpdateTypes") == ["major"] and r.get("automerge") is False for r in rules))
        self.assertNotIn("automerge", self.policy["vulnerabilityAlerts"])

    def test_mergify_does_not_queue_or_housekeep_renovate(self):
        self.assertEqual(self.mergify["merge_protections_settings"]["auto_merge_conditions"], ["-author = renovate[bot]", "label = merge-ready"])
        for rule in self.mergify["queue_rules"]:
            self.assertIn("-author = renovate[bot]", rule["queue_conditions"])
        for rule in self.mergify["pull_request_rules"]:
            self.assertIn("-author = renovate[bot]", rule["conditions"])

    def test_existing_required_security_and_ci_results_remain(self):
        gate = next(r for r in self.mergify["merge_protections"] if r["name"] == "main branch validation")
        for condition in ["#changes-requested-reviews-by = 0", "check-success = @github-actions/validate (ubuntu-24.04)", "check-success = @github-actions/validate (macos-14)", "check-success = @github-actions/secrets", "check-success = qlty check", "check-success = @gitguardian/GitGuardian Security Checks", "check-success = @socket-security/Socket Security: Pull Request Alerts"]:
            self.assertIn(condition, gate["success_conditions"])
