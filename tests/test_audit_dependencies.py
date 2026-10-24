"""Advisory coverage and fail-closed behavior use mocked npm, never the network."""
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader
import json
from pathlib import Path
# qlty-ignore(bandit:B404): Mocked subprocess.CompletedProcess fixtures only.
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/audit_dependencies.py'
SPEC = spec_from_loader('audit_dependencies', SourceFileLoader('audit_dependencies', str(SCRIPT)))
module = module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class AdvisoryTests(unittest.TestCase):
    def fixture(self, root):
        for name in module.LOCKFILES:
            lock = root / name
            lock.parent.mkdir(parents=True, exist_ok=True)
            lock.write_text('{"lockfileVersion":3}')
            (lock.parent / 'package.json').write_text('{"name":"fixture"}')

    @staticmethod
    def report(*, high=0, moderate=0, package='vite'):
        return json.dumps({
            "metadata": {"vulnerabilities": {"info": 0, "low": 0, "moderate": moderate,
                                            "high": high, "critical": 0}},
            "vulnerabilities": ({package: {"severity": "high"}} if high else {}),
        })

    def test_both_root_and_nested_dev_lockfiles_are_audited_without_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            calls = []
            def runner(command, **kwargs):
                calls.append((command, kwargs))
                return subprocess.CompletedProcess(command, 0, self.report(moderate=1))
            reports = module.audit_dependencies(root, runner=runner)
            self.assertEqual(len(reports), 2)
            self.assertEqual([str(x[1]['cwd'].relative_to(root)) for x in calls],
                             ['.', 'skills/turnstile-spin/templates/worker'])
            for command, arguments in calls:
                self.assertEqual(command[:2], ['npm', 'audit'])
                self.assertIn('--package-lock-only', command)
                self.assertIn('--ignore-scripts', command)
                # Explicit CLI include defeats NODE_ENV=production/npm omit=dev defaults.
                self.assertIn('--include=dev', command)
                self.assertNotIn('--omit=dev', command)
                self.assertEqual(arguments['timeout'], 120)

    def test_high_advisory_is_a_failure_not_a_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            with self.assertRaisesRegex(RuntimeError, "high/critical"):
                module.audit_dependencies(root, runner=lambda cmd, **kwargs:
                    subprocess.CompletedProcess(cmd, 1, self.report(high=1)))

    def test_transport_and_nonjson_errors_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                module.audit_dependencies(root, runner=lambda cmd, **kwargs:
                    subprocess.CompletedProcess(cmd, 1, "registry timeout"))
            def timed_out(command, **kwargs):
                raise subprocess.TimeoutExpired(command, 120)
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                module.audit_dependencies(root, runner=timed_out)

    def test_unexpected_stderr_fails_closed_even_with_valid_json_and_zero_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            def runner(command, **kwargs):
                return subprocess.CompletedProcess(command, 0, self.report(), "registry degraded")
            with self.assertRaisesRegex(RuntimeError, "stderr unavailable"):
                module.audit_dependencies(root, runner=runner)

    def test_missing_nested_lockfile_is_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.fixture(root)
            (root / module.LOCKFILES[1]).unlink()
            with self.assertRaisesRegex(RuntimeError, "Missing audited"):
                module.audit_dependencies(root, runner=lambda cmd, **kwargs:
                    subprocess.CompletedProcess(cmd, 0, self.report()))


if __name__ == '__main__':
    unittest.main()
