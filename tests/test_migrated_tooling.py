import json
import os
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
    @staticmethod
    def event(content):
        return {
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "content": content},
        }

    def stream(self, *events):
        producer = "import json; events = " + repr(events) + "; [print(json.dumps(event), flush=True) for event in events]"
        return subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", producer],
            text=True, capture_output=True,
        )

    def test_extracts_valid_final_tool_free_verdicts(self):
        for candidate in ({"verdict": "PASS", "findings": []},
                          {"verdict": "FAIL", "findings": ["critical defect"]}):
            with self.subTest(candidate=candidate):
                result = self.stream(self.event(json.dumps(candidate)))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), candidate)

    def test_malformed_final_candidates_fail_closed(self):
        candidates = (
            {"verdict": "PASS", "findings": ["critical defect"]},
            {"verdict": "PASS"},
            {"findings": []},
            {"verdict": "PASS", "findings": "not a list"},
            {"verdict": "FAIL", "findings": [None]},
            {"verdict": "FAIL", "findings": [" \t "]},
            {"verdict": "PASS", "findings": [], "extra": True},
            {"verdict": "FAIL", "findings": []},
            {"verdict": "UNKNOWN", "findings": []},
        )
        for candidate in candidates:
            with self.subTest(candidate=candidate):
                result = self.stream(self.event(json.dumps(candidate)))
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_non_json_and_non_string_final_candidates_fail_closed(self):
        for content in ('{"verdict":', None):
            with self.subTest(content=content):
                result = self.stream(self.event(content))
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_invalid_final_cannot_be_followed_by_a_clean_pass(self):
        result = self.stream(
            self.event(json.dumps({"verdict": "PASS", "findings": ["defect"]})),
            self.event(json.dumps({"verdict": "PASS", "findings": []})),
        )
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_non_object_event_envelopes_and_progress_do_not_crash(self):
        result = self.stream(
            [], None, {"type": "message_update", "assistantMessageEvent": []},
            {"type": "progress"}, self.event(json.dumps({"verdict": "PASS", "findings": []})),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"verdict": "PASS", "findings": []})

    def test_process_without_verdict_fails_closed(self):
        result = subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", "print('{}')"],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 125)

    def test_process_without_verdict_times_out(self):
        result = subprocess.run(
            [sys.executable, str(STREAM), "0.05", sys.executable, "-c", "import time; time.sleep(30)"],
            text=True, capture_output=True, timeout=3,
        )
        self.assertEqual(result.returncode, 124)
        self.assertEqual(result.stdout, "")

    def test_invalid_final_kills_live_child_before_waiting(self):
        producer = (
            "import json, time; print(json.dumps("
            + repr(self.event(json.dumps({"verdict": "PASS", "findings": ["defect"]})))
            + "), flush=True); time.sleep(30)"
        )
        result = subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", producer],
            text=True, capture_output=True, timeout=3,
        )
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_gate_rejects_contradictory_pass_without_environment_skip(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            subprocess.run(["git", "init", "-q", "--initial-branch=main", str(root)], check=True)

            def git(*args):
                return subprocess.run(
                    ["git", "-c", "user.name=Review Fixture", "-c", "user.email=review@example.test", *args],
                    cwd=root, text=True, capture_output=True, check=True,
                ).stdout.strip()

            git("commit", "-qm", "base", "--allow-empty")
            remote_sha = git("rev-parse", "HEAD")
            (root / "change.txt").write_text("changed\n")
            git("add", "change.txt")
            git("commit", "-qm", "candidate")
            local_sha = git("rev-parse", "HEAD")
            helper = root / "scripts" / "review" / "stream_verdict.py"
            helper.parent.mkdir(parents=True)
            helper.symlink_to(STREAM)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            invocation = root / "omp-arguments"
            payload = json.dumps(self.event(json.dumps({"verdict": "PASS", "findings": ["critical defect"]})))
            omp = bin_dir / "omp"
            omp.write_text(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$OMP_ARGUMENTS\"\n"
                "printf '%s\\n' '" + payload + "'\n"
            )
            omp.chmod(0o755)
            env = os.environ.copy()
            env.update(
                PATH=str(bin_dir) + os.pathsep + env.get("PATH", ""),
                OMP_ARGUMENTS=str(invocation),
                ADVERSARIAL_REVIEW_SKIP="1",
                ADVERSARIAL_REVIEW_TIMEOUT="5",
            )
            result = subprocess.run(
                ["bash", str(GATE)], cwd=root, env=env,
                input=f"refs/heads/main {local_sha} refs/heads/main {remote_sha}\n",
                text=True, capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no parseable verdict", result.stderr)
            self.assertIn("--no-tools", invocation.read_text())


if __name__ == "__main__":
    unittest.main()
