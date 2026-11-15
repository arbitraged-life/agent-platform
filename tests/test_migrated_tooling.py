import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RESOLVE = ROOT / "scripts" / "skills" / "resolve-skill-path.sh"
STREAM = ROOT / "scripts" / "review" / "stream_verdict.py"
GATE = ROOT / "scripts" / "review" / "adversarial-review-gate.sh"
GIT_EXECUTABLE = shutil.which("git")
BASH_EXECUTABLE = shutil.which("bash")


class SkillPathTests(unittest.TestCase):
    def test_resolves_valid_skill_path(self):
        # qlty-ignore(bandit:B603): Resolved executable, repository script and literal argv; no shell evaluation.
        result = subprocess.run(
            [BASH_EXECUTABLE, str(RESOLVE), "--name", "example-skill"],
            cwd=ROOT, text=True, capture_output=True, check=True,
        )
        self.assertEqual(result.stdout.strip(), "skills/example-skill/SKILL.md")

    def test_mkdir_creates_only_skill_directory(self):
        with tempfile.TemporaryDirectory() as td:
            # qlty-ignore(bandit:B603): Resolved executable, repository script and literal argv in a temporary fixture.
            result = subprocess.run(
                [BASH_EXECUTABLE, str(RESOLVE), "--name", "example-skill", "--mkdir"],
                cwd=td, text=True, capture_output=True, check=True,
            )
            self.assertEqual(result.stdout.strip(), "skills/example-skill/SKILL.md")
            self.assertTrue((Path(td) / "skills" / "example-skill").is_dir())

    def test_rejects_invalid_skill_name(self):
        # qlty-ignore(bandit:B603): Literal invalid-input fixture is passed as argv, never shell source.
        result = subprocess.run(
            [BASH_EXECUTABLE, str(RESOLVE), "--name", "../escape"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)


class ReviewStreamTests(unittest.TestCase):
    @staticmethod
    def event(content, *, stop_reason="stop"):
        return {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "stopReason": stop_reason,
                "content": [{"type": "text", "text": content}],
            },
        }

    @staticmethod
    def text_update(content):
        return {
            "type": "message_update",
            "assistantMessageEvent": {"type": "text_end", "content": content},
        }

    def stream(self, *events):
        producer = (
            "import json; events = " + repr(events)
            + "; [print(event if isinstance(event, str) else json.dumps(event), flush=True) for event in events]"
        )
        # qlty-ignore(bandit:B603): Current interpreter runs repository code and test-owned producer source without a shell.
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

    def test_waits_for_completed_message_after_text_blocks(self):
        candidate = {"verdict": "PASS", "findings": []}
        content = json.dumps(candidate)
        result = self.stream(
            self.text_update(content),
            self.text_update(""),
            self.event(content),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), candidate)

    def test_joins_all_text_blocks_in_completed_message(self):
        candidate = {"verdict": "FAIL", "findings": ["critical defect"]}
        content = json.dumps(candidate)
        message = self.event(content)
        message["message"]["content"] = [
            {"type": "thinking", "thinking": "internal reasoning"},
            {"type": "text", "text": content[:18]},
            {"type": "text", "text": content[18:]},
        ]
        result = self.stream(message)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), candidate)

    def test_rejects_trailing_text_after_initial_valid_block(self):
        message = self.event(json.dumps({"verdict": "PASS", "findings": []}))
        message["message"]["content"].append({"type": "text", "text": " extra"})
        result = self.stream(self.text_update(message["message"]["content"][0]["text"]), message)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_rejects_duplicate_verdict_fields_in_completed_message(self):
        content = '{"verdict":"FAIL","findings":[],"verdict":"PASS"}'
        result = self.stream(self.event(content))
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_rejects_duplicate_findings_fields_in_completed_message(self):
        content = '{"verdict":"PASS","findings":["critical defect"],"findings":[]}'
        result = self.stream(self.event(content))
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_rejects_duplicate_authoritative_envelope_fields(self):
        candidate = json.dumps({"verdict": "PASS", "findings": []})
        message = json.dumps(self.event(candidate))
        duplicate = message.replace('"stopReason": "stop"', '"stopReason": "error", "stopReason": "stop"')
        result = self.stream(duplicate)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_deeply_nested_event_and_candidate_json_fail_closed(self):
        nested = "[" * 2000 + "0" + "]" * 2000
        envelope = '{"type":"message_end","message":' + nested + '}'
        for payload in (envelope, self.event(nested)):
            with self.subTest(envelope=isinstance(payload, str)):
                result = self.stream(payload)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertEqual(result.stdout, "")

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

    def test_invalid_completed_message_cannot_be_followed_by_pass(self):
        result = self.stream(
            self.event(json.dumps({"verdict": "PASS", "findings": []}), stop_reason="error"),
            self.event(json.dumps({"verdict": "PASS", "findings": []})),
        )
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_rejects_non_text_outcomes_and_malformed_completed_messages(self):
        valid = json.dumps({"verdict": "PASS", "findings": []})
        def message_with(**fields):
            event = self.event(valid)
            event["message"].update(fields)
            return event

        cases = (
            self.event(valid, stop_reason="toolUse"),
            self.event(valid, stop_reason="length"),
            self.event(valid, stop_reason="aborted"),
            message_with(content=[
                {"type": "toolCall", "name": "bash"},
                {"type": "text", "text": valid},
            ]),
            message_with(content=[None]),
            message_with(content=valid),
            message_with(content=[{"type": "thinking", "thinking": "no verdict"}]),
            message_with(content=[
                {"type": "thinking", "thinking": 42},
                {"type": "text", "text": valid},
            ]),
            message_with(stopReason=None),
            message_with(errorMessage="provider failure"),
            message_with(errorMessage=0),
            message_with(errorMessage=None),
            {"type": "message_end", "message": None},
        )
        for case in cases:
            with self.subTest(case=case):
                result = self.stream(case)
                self.assertEqual(result.returncode, 125, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_non_object_event_envelopes_and_progress_do_not_crash(self):
        result = self.stream(
            [], None, {"type": "message_update", "assistantMessageEvent": []},
            {"type": "progress"}, self.text_update('{"verdict":"PASS","findings":[]}'),
            self.event(json.dumps({"verdict": "PASS", "findings": []})),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"verdict": "PASS", "findings": []})

    def test_process_without_verdict_fails_closed(self):
        result = subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", "print('{}')"],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 125)

    def test_text_only_stream_without_completed_message_fails_closed(self):
        result = self.stream(self.text_update('{"verdict":"PASS","findings":[]}'))
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_process_without_verdict_times_out(self):
        # qlty-ignore(bandit:B603): Current interpreter and literal sleeping fixture; bounded process timeout, no shell.
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
        # qlty-ignore(bandit:B603): Current interpreter runs a test-owned invalid-verdict producer, never external input.
        result = subprocess.run(
            [sys.executable, str(STREAM), "5", sys.executable, "-c", producer],
            text=True, capture_output=True, timeout=3,
        )
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_gate_rejects_contradictory_pass_without_environment_skip(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            # qlty-ignore(bandit:B603): Resolved Git executable and literal argv create only a temporary fixture repository.
            subprocess.run([GIT_EXECUTABLE, "init", "-q", "--initial-branch=main", str(root)], check=True)

            def git(*args):
                # qlty-ignore(bandit:B603): Resolved Git executable with test-owned argv and local fixture paths; no shell.
                return subprocess.run(
                    [GIT_EXECUTABLE, "-c", "user.name=Review Fixture", "-c", "user.email=review@example.test", *args],
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
            payload = json.dumps(self.event('{"verdict":"FAIL","findings":["critical defect"],"verdict":"PASS","findings":[]}'))
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
            # qlty-ignore(bandit:B603): Resolved Bash runs the repository gate with a test-owned producer and synthetic input.
            result = subprocess.run(
                [BASH_EXECUTABLE, str(GATE)], cwd=root, env=env,
                input=f"refs/heads/main {local_sha} refs/heads/main {remote_sha}\n",
                text=True, capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no parseable verdict", result.stderr)
            self.assertIn("--no-tools", invocation.read_text())


if __name__ == "__main__":
    unittest.main()
