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

    def test_merge_conflict_markers_are_not_bypassable(self):
        for marker in (
            "<<<<<<< HEAD", "=======", ">>>>>>> feature/topic",
            "||||||| base", "<<<<<<<<< configured", "========= ",
            "  <<<<<<< HEAD # ai-purity-ignore: merge-conflict",
        ):
            with self.subTest(marker=marker):
                result = self.audit("README.txt", marker)
                self.assertEqual(result["rule"], "MERGE-CONFLICT")
                self.assertIsNone(result["ignore_tag"])

    def test_markdown_setext_headings_are_not_merge_separators(self):
        for underline in ("=======", "==========", "  =======  "):
            with self.subTest(underline=underline):
                self.assertIsNone(self.audit("README.md", underline))

    def test_markdown_conflict_hunk_still_fails_closed(self):
        hunk = ("<<<<<<< HEAD", "Local paragraph", "=======",
                "Incoming paragraph", ">>>>>>> feature/topic")
        violations = [self.audit("README.md", line) for line in hunk]
        self.assertEqual([result["rule"] for result in violations if result],
                         ["MERGE-CONFLICT", "MERGE-CONFLICT"])
        for marker in ("||||||| base", "<<<<<<<<< configured", "========= with context"):
            with self.subTest(marker=marker):
                self.assertEqual(self.audit("README.md", marker)["rule"], "MERGE-CONFLICT")


    def test_ordinary_text_and_inline_operators_are_not_markers(self):
        for text in ("use <<<<<<< as an example", "a ======= b", "=======literal",
                     ">>>>>>>feature", "|||||||base", "some ordinary text"):
            with self.subTest(text=text):
                self.assertIsNone(self.audit("README.txt", text))


if __name__ == "__main__":
    unittest.main()
