"""Regression guard for the temporary GitHub Ubuntu 26.04 actionlint label exception."""
from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class RunnerLabelCompatibilityTests(unittest.TestCase):
    def test_exception_matches_only_the_verified_ga_label(self):
        config = yaml.safe_load((ROOT / ".github/actionlint.yaml").read_text())
        self.assertEqual(list(config), ["paths"])
        self.assertEqual(list(config["paths"]), [".github/workflows/**/*.yml"])
        patterns = config["paths"][".github/workflows/**/*.yml"]["ignore"]
        self.assertEqual(len(patterns), 1)
        rule = re.compile(patterns[0])
        self.assertTrue(rule.search('label "ubuntu-26.04" is unknown.'))
        self.assertFalse(rule.search('label "ubuntu-24.04" is unknown.'))
        self.assertFalse(rule.search('label "ubuntu-26.04-arm" is unknown.'))
        self.assertFalse(rule.search("shellcheck reported issue in this script"))


if __name__ == "__main__":
    unittest.main()
