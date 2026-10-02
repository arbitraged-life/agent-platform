"""Exercise reusable lint discovery and failure propagation without network access."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/lint-reusable.yml').read_text())


def script(job, name=None):
    return next(step['run'] for step in WORKFLOW['jobs'][job]['steps']
                if 'run' in step and (name is None or step.get('name') == name))


class ReusableLintTests(unittest.TestCase):
    def test_discovery_uses_tracked_files_and_literal_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', directory], check=True)
            for name in ['code/space name.py', 'code/line\nbreak.ts', 'code/$(touch sentinel).sh',
                         'vendor/ignored.swift', 'node_modules/dependency.cpp']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('')
                subprocess.run(['git', '-C', directory, 'add', '--', name], check=True)
            (root / 'untracked.swift').write_text('')
            output = root / 'outputs'
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', script('detect')],
                                    cwd=root, env={**os.environ, 'GITHUB_OUTPUT': str(output)},
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(dict(line.split('=') for line in output.read_text().splitlines()),
                             {'swift': 'false', 'python': 'true', 'js': 'true',
                              'shell': 'true', 'yaml': 'false', 'cpp': 'false'})
            self.assertFalse((root / 'sentinel').exists())

    def run_cpp(self, strict, install_status=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sudo = root / 'sudo'
            sudo.write_text('#!/bin/sh\nexit ' + str(install_status) + '\n')
            cpp = root / 'cppcheck'
            cpp.write_text('#!/bin/sh\nfor arg do\ncase "$arg" in\n'
                           '--error-exitcode=*) exit "${arg#*=}";;\nesac\ndone\nexit 99\n')
            sudo.chmod(0o700)
            cpp.chmod(0o700)
            command = script('cpp').replace('${{ inputs.strict }}', str(strict).lower())
            return subprocess.run(['bash', '-euo', 'pipefail', '-c', command], cwd=root,
                                  env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH']},
                                  capture_output=True, text=True).returncode

    def test_cpp_strict_findings_fail(self):
        self.assertEqual(self.run_cpp(True), 1)

    def test_cpp_advisory_findings_pass(self):
        self.assertEqual(self.run_cpp(False), 0)

    def test_install_failure_is_not_advisory(self):
        self.assertEqual(self.run_cpp(False, install_status=47), 47)

    def test_secret_scan_is_independent_and_not_advisory(self):
        job = WORKFLOW['jobs']['secrets']
        self.assertNotIn('needs', job)
        self.assertNotIn('if', job)
        self.assertNotIn('continue-on-error', job)
        for step in job['steps']:
            self.assertNotIn('continue-on-error', step)
        self.assertLess(script('secrets').index('sha256sum --check'),
                        script('secrets').index('tar -xzf'))

    def test_only_lint_step_is_advisory_after_python_install(self):
        steps = WORKFLOW['jobs']['python']['steps']
        self.assertNotIn('continue-on-error', steps[-2])
        self.assertEqual(steps[-1]['continue-on-error'], '${{ !inputs.strict }}')


if __name__ == '__main__':
    unittest.main()
