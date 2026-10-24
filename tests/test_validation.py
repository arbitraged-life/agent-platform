from importlib.machinery import SourceFileLoader
from importlib.util import spec_from_loader, module_from_spec
from pathlib import Path
# qlty-ignore(bandit:B404): Git fixture operations use argv without a shell.
import subprocess
import sys
import shutil
import tempfile
import unittest
from unittest.mock import patch

GIT_EXECUTABLE = shutil.which('git')

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/validate'
SPEC = spec_from_loader('validation', SourceFileLoader('validation', str(SCRIPT)))
validation = module_from_spec(SPEC)
SPEC.loader.exec_module(validation)


class BoundaryTests(unittest.TestCase):
    def test_relative_imports_are_resolved_against_the_containing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'nested' / 'entry.mjs'
            file.parent.mkdir()
            with patch.object(validation, 'ROOT', root):
                file.write_text("import '../../private/module.mjs';\n")
                self.assertTrue(validation.boundaries([file]))
                file.write_text("import '../runtime/module.mjs';\n")
                self.assertEqual(validation.boundaries([file]), [])

    def test_private_key_labels_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'fixture.txt'
            for label in ['DSA', 'ENCRYPTED', 'RSA', 'OPENSSH']:
                file.write_text('-----BEGIN ' + label + ' PRIVATE KEY-----')
                self.assertTrue(validation.boundaries([file], root))

    def test_workflow_pins_use_parsed_yaml_keys_and_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / '.github/workflows/check.yml'
            file.parent.mkdir(parents=True)
            for key in ['uses', '"uses"', "'uses'", 'uses ', '"u\\u0073es"']:
                with self.subTest(key=key):
                    file.write_text('jobs:\n  test:\n    steps:\n      - ' + key + ': actions/checkout@main\n')
                    self.assertTrue(validation.boundaries([file], root))
                    file.write_text('jobs:\n  test:\n    steps:\n      - ' + key + ': "actions/checkout@' + 'a' * 40 + '"\n')
                    self.assertEqual(validation.boundaries([file], root), [])
            for content in ['jobs: {test: {uses: owner/repo/workflow@main}}',
                            'jobs: {test: {steps: [{uses: null}]}}', 'jobs: [bad]', 'invalid: [']:
                file.write_text(content)
                self.assertTrue(validation.boundaries([file], root))

    def test_scheduled_advisory_gate_runs_without_optional_test_insights_credential(self):
        root = Path(__file__).resolve().parents[1]
        workflow = validation.yaml.safe_load((root / '.github/workflows/test-insights.yml').read_text())
        steps = workflow['jobs']['node-tests']['steps']
        audit = next(step for step in steps if step.get('name') == 'Check current dependency advisories (existing scheduled run)')
        self.assertEqual(audit['if'], "github.event_name == 'schedule'")
        self.assertEqual(audit['run'], 'python3 scripts/audit_dependencies.py')
        for step in steps:
            if step.get('uses', '').startswith(('actions/checkout@', 'actions/setup-node@')):
                self.assertIn("github.event_name == 'schedule'", step['if'])

    def test_validator_dispatches_advisory_gate_only_for_ci_and_security(self):
        for command in ['ci', 'security', 'lint', 'test']:
            with self.subTest(command=command):
                with patch.object(sys, 'argv', ['validate', command]), \
                     patch.object(validation, 'source_files', return_value=[]), \
                     patch.object(validation, 'lint_sources'), \
                     patch.object(validation.subprocess, 'run') as mock_run:
                    validation.main()
                audit = [call for call in mock_run.call_args_list if
                         any('scripts/audit_dependencies.py' in str(part)
                             for part in call.args[0])]
                self.assertEqual(len(audit), 1 if command in {'ci', 'security'} else 0)
                if audit:
                    self.assertIs(audit[0].kwargs['check'], True)
                    self.assertEqual(audit[0].kwargs['cwd'], validation.ROOT)

    def test_renovate_remediates_security_prs_without_expanding_merge_permissions(self):
        root = Path(__file__).resolve().parents[1]
        import json
        policy = json.loads((root / 'renovate.json').read_text())
        self.assertTrue(policy['vulnerabilityAlerts']['enabled'])
        self.assertEqual(policy['vulnerabilityAlerts']['schedule'], [])
        self.assertEqual(policy['vulnerabilityAlerts']['prCreation'], 'immediate')
        rules = [rule for rule in policy['packageRules'] if
                 set(rule.get('matchDatasources', [])) == {'node-version','python-version'}]
        # Preserve the main branch's general review-only runtime rule while
        # allowing one stricter immediate security patch rule later in order.
        self.assertEqual(len(rules), 2)
        self.assertTrue(all(rule['automerge'] is False for rule in rules))
        self.assertTrue(all(rule['dependencyDashboardApproval'] is True for rule in rules))
        patches = [rule for rule in rules if rule.get('matchUpdateTypes') == ['patch']]
        self.assertEqual(len(patches), 1)
        self.assertEqual(patches[0]['schedule'], [])
        self.assertIn('security-toolchain', patches[0]['addLabels'])

    def test_environment_variants_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ['.env', '.env.local', '.env.production']:
                file = root / name
                file.write_text('CONFIG=value')
                self.assertTrue(validation.boundaries([file], root))

    @unittest.skipUnless(GIT_EXECUTABLE, "Git is required for index validation")
    def test_index_is_checked_even_when_worktree_differs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # qlty-ignore(bandit:B603): Resolved Git executable with literal argv and local fixture paths.
            subprocess.run([GIT_EXECUTABLE, 'init', '-q', str(root)], check=True)
            file = root / 'example.txt'
            file.write_text('-----BEGIN ' + 'PRIVATE KEY-----')
            # qlty-ignore(bandit:B603): Resolved Git executable with literal argv and local fixture paths.
            subprocess.run([GIT_EXECUTABLE, '-C', str(root), 'add', 'example.txt'], check=True)
            file.write_text('safe working copy')
            with patch.object(validation, 'ROOT', root):
                with self.assertRaisesRegex(SystemExit, 'private key'):
                    validation.lint_index()
                file.unlink()
                with self.assertRaisesRegex(SystemExit, 'private key'):
                    validation.lint_index()
                # qlty-ignore(bandit:B603): Resolved Git executable with literal argv and local fixture paths.
                subprocess.run([GIT_EXECUTABLE, '-C', str(root), 'rm', '--cached', '-f', 'example.txt'], check=True, capture_output=True)
                validation.lint_index()

    def test_local_and_floating_package_dependencies_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'package.json'
            with patch.object(validation, 'ROOT', root):
                for version in ['file:../private', 'latest', '^1.2.3', 'github:owner/repo#main']:
                    file.write_text('{"dependencies":{"module":"' + version + '"}}')
                    self.assertTrue(validation.boundaries([file]))
                file.write_text('{"devDependencies":{"module":"1.2.3"}}')
                self.assertEqual(validation.boundaries([file]), [])

    def test_composite_actions_and_production_dependencies_cannot_escape_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            action = root / 'action.yml'
            action.write_text('runs: {using: composite, steps: [{uses: actions/checkout@main}]}')
            self.assertTrue(validation.boundaries([action], root))
            action.write_text('runs: {using: composite, steps: [{uses: actions/checkout@' + 'a' * 40 + '}]}')
            self.assertEqual(validation.boundaries([action], root), [])
            package = root / 'package.json'
            for group in ['dependencies', 'optionalDependencies', 'peerDependencies']:
                package.write_text('{"' + group + '":{"module":"1.2.3"}}')
                self.assertTrue(validation.boundaries([package], root))

    def test_workflow_named_action_is_not_composite_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = root / '.github/workflows/action.yml'
            workflow.parent.mkdir(parents=True)
            workflow.write_text('jobs: {test: {runs-on: ubuntu-latest, steps: [{run: echo ok}]}}')
            self.assertEqual(validation.boundaries([workflow], root), [])

    def test_machine_local_imports_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            module = root / 'entry.mjs'
            for specifier in ['/opt/company/runtime.mjs', 'file:///opt/runtime.mjs', 'C:/runtime.mjs']:
                module.write_text('im' + 'port ' + repr(specifier))
                self.assertTrue(validation.boundaries([module], root))


if __name__ == '__main__':
    unittest.main()
