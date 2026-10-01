from importlib.machinery import SourceFileLoader
from importlib.util import spec_from_loader, module_from_spec
from pathlib import Path
# qlty-ignore(bandit:B404): Git fixture operations use argv without a shell.
import subprocess
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


if __name__ == '__main__':
    unittest.main()
