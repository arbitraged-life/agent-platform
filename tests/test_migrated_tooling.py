import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESOLVE = ROOT / "scripts" / "skills" / "resolve-skill-path.sh"
STREAM = ROOT / "scripts" / "review" / "stream_verdict.py"
GATE = ROOT / "scripts" / "review" / "adversarial-review-gate.sh"


class SkillPathTests(unittest.TestCase):
    def test_resolves_valid_skill_path(self):
        result = subprocess.run(
            ["bash", str(RESOLVE), "--name", "example-skill"],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        self.assertEqual(result.stdout.strip(), "skills/example-skill/SKILL.md")

    def test_mkdir_creates_only_skill_directory(self):
        with tempfile.TemporaryDirectory() as td:
            result = subprocess.run(
                ["bash", str(RESOLVE), "--name", "example-skill", "--mkdir"],
                cwd=td, text=True, capture_output=True, check=True,
            )
            self.assertEqual(result.stdout.strip(), "skills/example-skill/SKILL.md")
            self.assertTrue((Path(td) / "skills" / "example-skill").is_dir())

    def test_rejects_invalid_skill_name(self):
        result = subprocess.run(
            ["bash", str(RESOLVE), "--name", "../escape"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)


class ReviewStreamTests(unittest.TestCase):
    def test_extracts_final_tool_free_verdict(self):
        event = {
            "type": "message_update",
            "assistantMessageEvent": {
                "type": "text_end",
                "content": json.dumps({"verdict": "PASS", "findings": []}),
            },
        }
        producer = (
            "import json; print(json.dumps(" + repr(event) + "))"
        )
        result = subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", producer],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["verdict"], "PASS")

    def test_process_without_verdict_fails_closed(self):
        result = subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", "print('{}')"],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 125)

    def test_gate_has_no_environment_skip_bypass(self):
        text = GATE.read_text()
        self.assertNotIn("ADVERSARIAL_REVIEW_SKIP", text)
        self.assertIn("--no-tools", text)


if __name__ == "__main__":
    unittest.main()
