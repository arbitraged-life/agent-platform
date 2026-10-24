"""Public dependency merge ownership and eligibility contract."""
import json
import re
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

    def test_npm_release_age_is_timestamp_required_and_fail_closed(self):
        rules = self.policy["packageRules"]
        cooldown = next(r for r in rules if r.get("matchDatasources") == ["npm"])
        self.assertEqual(cooldown["minimumReleaseAge"], "14 days")
        self.assertEqual(cooldown["minimumReleaseAgeBehaviour"], "timestamp-required")
        self.assertEqual(cooldown["internalChecksFilter"], "strict")
        self.assertIn("security:minimumReleaseAgePypi", self.policy["extends"])

    def test_high_risk_rules_take_precedence_over_general_automerge(self):
        rules = self.policy["packageRules"]
        start = next(i for i, r in enumerate(rules) if r.get("minimumReleaseAge") == "14 days")
        self.assertGreater(start, max(i for i, r in enumerate(rules) if r.get("automerge") is True))
        restricted = rules[start:]
        self.assertEqual(len(restricted), 9)
        for rule in restricted[1:]:
            self.assertIs(rule["automerge"], False)
            self.assertIs(rule["dependencyDashboardApproval"], True)
        self.assertEqual(restricted[1]["matchDatasources"], ["npm"])
        self.assertEqual(set(restricted[1]["matchUpdateTypes"]),
                         {"pin", "pinDigest", "digest", "lockFileMaintenance"})
        self.assertIsNone(restricted[1]["minimumReleaseAge"])
        managers = set(restricted[2]["matchManagers"])
        self.assertTrue({"github-actions", "terraform", "circleci", "dockerfile",
                         "docker-compose", "custom.regex"}.issubset(managers))
        paths = restricted[3]["matchFileNames"]
        self.assertTrue({"infra/**", ".github/workflows/**", ".circleci/**"}.issubset(paths))
        self.assertEqual(restricted[4]["matchDatasources"], ["node-version", "python-version"])
        packages = restricted[5]["matchPackageNames"]
        self.assertTrue({"@modelcontextprotocol/**", "@cloudflare/**", "wrangler",
                         "miniflare", "@google-cloud/**", "@azure/**", "jose",
                         "cryptography", "google-auth", "mcp"}.issubset(packages))
        self.assertEqual(restricted[6]["matchUpdateTypes"], ["lockFileMaintenance"])
        self.assertIs(restricted[6]["automerge"], False)
        self.assertIsNone(restricted[6]["minimumReleaseAge"])
        self.assertEqual(set(restricted[7]["matchUpdateTypes"]),
                         {"lockfileUpdate", "rollback", "bump", "replacement"})
        self.assertIs(restricted[7]["automerge"], False)
        self.assertIsNone(restricted[7]["minimumReleaseAge"])
        security_patch = restricted[8]
        self.assertEqual(security_patch["matchDatasources"], ["node-version", "python-version"])
        self.assertEqual(security_patch["matchUpdateTypes"], ["patch"])
        self.assertEqual(security_patch["schedule"], [])
        self.assertIs(security_patch["automerge"], False)
        self.assertIs(security_patch["dependencyDashboardApproval"], True)
        self.assertIn("security-toolchain", security_patch["addLabels"])
        self.assertEqual(self.policy["vulnerabilityAlerts"]["schedule"], [])
        self.assertEqual(self.policy["vulnerabilityAlerts"]["prCreation"], "immediate")
        self.assertTrue(self.policy["platformAutomerge"])
        self.assertFalse(self.policy["ignoreTests"])

    def test_mergify_does_not_queue_or_housekeep_renovate(self):
        # auto_merge_conditions triggers autoqueue, not just a required check.
        # A required Mergify status can evaluate Renovate without queueing it.
        self.assertNotIn("auto_merge_conditions", self.mergify["merge_protections_settings"])
        # Security PRs cannot enter the queue, so no unreachable high-priority
        # security queue rule should suggest otherwise.
        self.assertNotIn("priority_rules", self.mergify)
        queued = [r for r in self.mergify["pull_request_rules"] if "queue" in r["actions"]]
        self.assertEqual(len(queued), 1)
        self.assertEqual(queued[0]["actions"]["queue"]["name"], "default")
        self.assertIn("check-success = @mergify/Mergify Merge Protections", queued[0]["conditions"])
        self.assertIn("-author = renovate[bot]", queued[0]["conditions"])
        self.assertIn("-title ~= (?i)security", queued[0]["conditions"])
        self.assertIn("#approved-reviews-by >= 1", queued[0]["conditions"])
        # Renaming a security PR does not remove the independent review gate.
        choices = next(c["or"] for c in queued[0]["conditions"] if isinstance(c, dict))
        self.assertEqual(choices, [
            "label = merge-ready",
            {"and": ["author = arbitraged-life", "-from-fork", "number > 87"]},
        ])
        # No PR is queued merely to satisfy its required Mergify check.
        for rule in self.mergify["queue_rules"]:
            self.assertIn("-author = renovate[bot]", rule["queue_conditions"])
            self.assertIn("-title ~= (?i)security", rule["queue_conditions"])
            self.assertIn("#approved-reviews-by >= 1", rule["queue_conditions"])
        for rule in self.mergify["pull_request_rules"]:
            self.assertIn("-author = renovate[bot]", rule["conditions"])

    def test_actionlint_compatibility_is_one_exact_runner_label(self):
        config = yaml.safe_load((ROOT / ".github/actionlint.yaml").read_text())
        ignores = config["paths"][".github/workflows/**/*.{yml,yaml}"]["ignore"]
        self.assertEqual(len(ignores), 1)
        regex = ignores[0]
        self.assertIsNotNone(re.search(regex, 'label "ubuntu-26.04" is unknown. available labels are ...'))
        for other in ('label "ubuntu-26.04-arm" is unknown.',
                      'label "ubuntu-26.05" is unknown.',
                      'job has unpinned uses reference',
                      'label "ubuntu-26.04" conflicts with other label'):
            self.assertIsNone(re.search(regex, other))

    def test_existing_required_security_and_ci_results_remain(self):
        gate = next(r for r in self.mergify["merge_protections"] if r["name"] == "main branch validation")
        for condition in ["#changes-requested-reviews-by = 0", "check-success = @github-actions/validate (ubuntu-24.04)", "check-success = @github-actions/validate (macos-14)", "check-success = @github-actions/secrets", "check-success = qlty check", "check-success = @gitguardian/GitGuardian Security Checks", "check-success = @socket-security/Socket Security: Pull Request Alerts"]:
            self.assertIn(condition, gate["success_conditions"])
