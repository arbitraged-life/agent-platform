import ast
import re
from collections.abc import Mapping
from importlib.machinery import SourceFileLoader
from itertools import product
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


def condition_lexeme(lexeme: str, values: Mapping[str, str], prior_success: bool) -> str:
    operators = {'&&': 'and', '||': 'or', '==': '==', '(': '(', ')': ')'}
    if lexeme in operators:
        return operators[lexeme]
    if lexeme == 'always()':
        return 'True'
    if lexeme == 'success()':
        return str(prior_success)
    if lexeme.startswith("'"):
        return lexeme
    if lexeme in values:
        return repr(values[lexeme])
    raise AssertionError(f"Unexpected workflow condition symbol: {lexeme}")


def condition_boolean(node, expression: str):
    if isinstance(node, ast.Constant) and type(node.value) in (bool, str):
        return node.value
    if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)):
        operands = [condition_boolean(value, expression) for value in node.values]
        return all(operands) if isinstance(node.op, ast.And) else any(operands)
    if isinstance(node, ast.Compare) and len(node.ops) == 1 and isinstance(node.ops[0], ast.Eq):
        return condition_boolean(node.left, expression) == condition_boolean(node.comparators[0], expression)
    raise AssertionError(f"Unsupported workflow condition: {expression}")


def workflow_condition(expression: str, values: Mapping[str, str],
                       prior_success: bool = True) -> bool:
    """Evaluate only the boolean GitHub condition vocabulary used in this workflow."""
    raw = expression.strip()
    if raw.startswith('${{') and raw.endswith('}}'):
        raw = raw[3:-2].strip()
    lexemes = re.findall(r"'[^']*'|[A-Za-z_][\w.-]*(?:\(\))?|==|&&|\|\||[()]", raw)
    if ''.join(lexemes) != ''.join(raw.split()):
        raise AssertionError(f"Unrecognized workflow condition: {raw}")
    converted = [condition_lexeme(lexeme, values, prior_success) for lexeme in lexemes]
    tree = ast.parse(' '.join(converted), mode='eval')
    return bool(condition_boolean(tree.body, raw)) and (
        prior_success or 'always()' in lexemes or 'success()' in lexemes
    )


class BoundaryTests(unittest.TestCase):
    def test_optional_discovery_requires_importable_package_ancestors(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            nested = root / 'optional_checks' / 'deeper'
            nested.mkdir(parents=True)
            (nested / 'test_example.py').write_text('import unittest\n')
            self.assertFalse(validation.has_discoverable_tests(root))
            (nested / '__init__.py').touch()
            self.assertFalse(validation.has_discoverable_tests(root))
            (nested.parent / '__init__.py').touch()
            self.assertTrue(validation.has_discoverable_tests(root))
            (nested / 'test_example.py').unlink()
            (root / 'test_top_level.py').write_text('import unittest\n')
            self.assertTrue(validation.has_discoverable_tests(root))

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

    def test_test_insights_credentials_are_isolated_from_candidate_execution(self):
        root = Path(__file__).resolve().parents[1]
        workflow = validation.yaml.safe_load(
            (root / '.github/workflows/test-insights.yml').read_text())
        jobs = workflow['jobs']
        self.assertEqual(workflow['permissions'], {'contents': 'read'})
        config = jobs['insights-config']
        tests = jobs['node-tests']

        self.assertNotIn('secrets.', str({key: value for key, value in config.items() if key != 'steps'}))
        self.assertNotIn('env', config)
        self.assertNotIn('secrets.', str(tests))
        self.assertNotIn('MERGIFY_TOKEN', str(tests))
        self.assertTrue(any(step.get('uses', '').startswith('actions/checkout@') for step in tests['steps']))
        self.assertFalse(any('Mergifyio/' in step.get('uses', '') for step in tests['steps']))
        self.assertTrue(all('uses' not in step for step in config['steps']))
        secret_steps = [step for step in config['steps'] if 'secrets.' in str(step)]
        self.assertEqual(secret_steps, config['steps'])
        for step in secret_steps:
            self.assertEqual(step.get('env'), {'MERGIFY_TOKEN': '${{ secrets.MERGIFY_TOKEN }}'})
            for token in ('', 'synthetic-audit-credential'):
                with self.subTest(credential=bool(token)), tempfile.TemporaryDirectory() as tmp:
                    output = Path(tmp) / 'outputs'
                    # qlty-ignore(bandit:B603): Repository workflow shell with synthetic credentials in an isolated fixture.
                    result = subprocess.run(['/bin/sh', '-e', '-c', step['run']], cwd=tmp,
                                            env={'MERGIFY_TOKEN': token, 'GITHUB_OUTPUT': str(output)},
                                            text=True, capture_output=True, check=True, timeout=5)
                    self.assertEqual(output.read_text().splitlines(),
                                     ['available=' + str(bool(token)).lower()])
                    if token:
                        self.assertNotIn(token, result.stdout + result.stderr)

    def test_test_insights_reports_cross_only_a_pinned_data_artifact_boundary(self):
        root = Path(__file__).resolve().parents[1]
        jobs = validation.yaml.safe_load(
            (root / '.github/workflows/test-insights.yml').read_text())['jobs']
        tests = jobs['node-tests']
        uploader = jobs['upload-test-insights']
        artifact = next(step for step in tests['steps']
                        if step.get('uses', '').startswith('actions/upload-artifact@'))
        download = next(step for step in uploader['steps']
                        if step.get('uses', '').startswith('actions/download-artifact@'))
        publish = next(step for step in uploader['steps']
                       if step.get('uses', '').startswith('Mergifyio/gha-mergify-ci@'))

        for step in (artifact, *uploader['steps']):
            self.assertRegex(step['uses'], r'^[^@]+@[0-9a-f]{40}$')
        self.assertRegex(artifact['with']['path'], r'^[A-Za-z0-9_-]+-\*\.xml$')
        self.assertTrue(download['with']['path'].startswith('${{ runner.temp }}/'))
        self.assertTrue(publish['with']['report_path'].endswith('.xml'))
        for key in ('github-token', 'run-id', 'repository'):
            self.assertNotIn(key, download['with'], 'Reports must come from the current workflow run')
        self.assertEqual(artifact['with']['if-no-files-found'], 'error')
        self.assertIs(artifact['with']['include-hidden-files'], False)
        self.assertEqual(publish['with']['token'], '${{ secrets.MERGIFY_TOKEN }}')
        self.assertEqual(publish['with']['action'], 'junit-process')
        self.assertEqual(str(uploader).count('secrets.'), 1)
        self.assertFalse(any('run' in step or 'env' in step or 'checkout@' in step.get('uses', '')
                             or 'cache@' in step.get('uses', '') for step in uploader['steps']))
        allowed_actions = {
            'actions/download-artifact', 'Mergifyio/gha-mergify-ci', 'step-security/harden-runner'
        }
        self.assertTrue(all(step['uses'].split('@', 1)[0] in allowed_actions
                            for step in uploader['steps']))

    def test_test_insights_gate_matrix_keeps_advisories_and_failed_tests(self):
        root = Path(__file__).resolve().parents[1]
        jobs = validation.yaml.safe_load(
            (root / '.github/workflows/test-insights.yml').read_text())['jobs']
        tests = jobs['node-tests']
        steps = tests['steps']
        run_tests = next(step for step in steps if step.get('id') == 'tests')
        artifact = next(step for step in steps
                        if step.get('uses', '').startswith('actions/upload-artifact@'))
        audit = next(step for step in steps
                     if step.get('run') == 'python3 scripts/audit_dependencies.py')
        failure = next(step for step in steps if step.get('run') == 'exit 1')
        uploader = jobs['upload-test-insights']
        self.assertTrue(run_tests['continue-on-error'])

        for event, credential, test_result, prior_ok, upstream_ok in product(
            ('schedule', 'pull_request'), (False, True), ('success', 'failure'),
            (False, True), (False, True)
        ):
            with self.subTest(event=event, credential=credential, test_result=test_result,
                              prior_ok=prior_ok, upstream_ok=upstream_ok):
                expected_job = upstream_ok and (event == 'schedule' or credential)
                tests_ran = expected_job and credential
                values = {
                    'github.event_name': event,
                    'needs.insights-config.outputs.available': str(credential).lower(),
                    'steps.tests.outcome': test_result if tests_ran else 'skipped',
                    'needs.node-tests.outputs.test-outcome': test_result if tests_ran else '',
                }
                self.assertEqual(workflow_condition(tests['if'], values, upstream_ok), expected_job)
                self.assertEqual(workflow_condition(run_tests['if'], values) and expected_job,
                                 tests_ran)
                self.assertEqual(workflow_condition(artifact['if'], values, prior_ok) and expected_job,
                                 tests_ran)
                self.assertEqual(workflow_condition(audit['if'], values, prior_ok) and expected_job,
                                 expected_job and event == 'schedule')
                self.assertEqual(workflow_condition(failure['if'], values, prior_ok) and expected_job,
                                 tests_ran and test_result == 'failure')
                self.assertEqual(workflow_condition(uploader['if'], values, prior_ok), tests_ran)

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
