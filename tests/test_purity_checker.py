import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "purity_checker", ROOT / "runtime" / "purity" / "purity_checker.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PurityCheckerTests(unittest.TestCase):
    def audit(self, path, line):
        return MODULE.audit_line(path, 1, line, line.strip())

    def test_detects_sync_js_blocker(self):
        result = self.audit("src/index.js", "const x = readFileSync(name)")
        self.assertEqual(result["rule"], "SYNC-BLOCKING")

    def test_detects_machine_local_user_path(self):
        result = self.audit("README.txt", "path=/" + "Users/alice/Code/example")
        self.assertEqual(result["rule"], "LEGACY-PATH")

    def test_placeholder_home_path_is_allowed(self):
        self.assertIsNone(self.audit("README.txt", "path=/" + "Users/user/Code/example"))

    def test_ignore_tag_preserves_deliberate_path(self):
        self.assertIsNone(self.audit(
            "README.txt",
            "path=/" + "Users/alice/Code/example # ai-purity-ignore: legacy-paths",
        ))


if __name__ == "__main__":
    unittest.main()
