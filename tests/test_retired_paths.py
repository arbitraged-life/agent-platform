"""Retirement guards preserve unrelated work and reject old-source development."""
import json
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest

MODULE = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/check-retired-paths.py'))


class RetiredPathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.root / 'old').mkdir()
        (self.root / 'old/runtime.txt').write_text('baseline')
        (self.root / 'other.txt').write_text('baseline')
        self.git('add', 'old/runtime.txt', 'other.txt')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture')
        self.policy = {'schema_version': 1, 'baseline_commit': self.git('rev-parse', 'HEAD').strip(),
                       'paths': [{'path': 'old', 'replacement': 'platform/runtime'}]}

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True)

    def test_staged_retired_changes_block_without_touching_dirty_work(self):
        (self.root / 'old/runtime.txt').write_text('new work')
        (self.root / 'other.txt').write_text('unrelated dirty work')
        self.git('add', 'old/runtime.txt')
        findings = MODULE['check'](self.root, self.policy)
        self.assertEqual(findings, [{'path': 'old/runtime.txt', 'replacement': 'platform/runtime'}])
        self.assertEqual((self.root / 'other.txt').read_text(), 'unrelated dirty work')

    def test_unstaged_changes_are_not_misreported_as_commit_changes(self):
        (self.root / 'old/runtime.txt').write_text('in progress')
        self.assertEqual(MODULE['check'](self.root, self.policy), [])
        self.assertEqual((self.root / 'old/runtime.txt').read_text(), 'in progress')

    def test_deletion_and_unrelated_prefix_are_allowed(self):
        self.git('rm', 'old/runtime.txt')
        (self.root / 'older.txt').write_text('unrelated')
        self.git('add', 'older.txt')
        self.assertEqual(MODULE['check'](self.root, self.policy), [])

    def test_pre_push_checks_committed_changes_against_immutable_baseline(self):
        (self.root / 'old/runtime.txt').write_text('new work')
        self.git('add', 'old/runtime.txt')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture update')
        revision = self.git('rev-parse', 'HEAD').strip()
        updates = 'refs/heads/topic ' + revision + ' refs/heads/topic ' + '0' * 40
        self.assertEqual(len(MODULE['check_push'](self.root, self.policy, updates)), 1)

    def test_reverted_edit_and_non_head_push_are_still_rejected(self):
        (self.root / 'old/runtime.txt').write_text('retired edit')
        self.git('add', 'old/runtime.txt')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'temporary edit')
        (self.root / 'old/runtime.txt').write_text('baseline')
        self.git('add', 'old/runtime.txt')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'restore old tree')
        revision = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '--quiet', '--detach', self.policy['baseline_commit'])
        updates = 'refs/heads/other ' + revision + ' refs/heads/other ' + '0' * 40
        findings = MODULE['check_push'](self.root, self.policy, updates)
        self.assertEqual(len(findings), 2)
        self.assertEqual({row['path'] for row in findings}, {'old/runtime.txt'})

    def test_malformed_push_input_fails_closed(self):
        with self.assertRaises(ValueError):
            MODULE['check_push'](self.root, self.policy, 'refs/heads/other HEAD')

    def test_annotated_tag_cannot_hide_retired_changes(self):
        (self.root / 'old/runtime.txt').write_text('tagged edit')
        self.git('add', 'old/runtime.txt')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'tagged edit')
        self.git('tag', '-a', 'release', '-m', 'fixture release')
        tag = self.git('rev-parse', 'release').strip()
        updates = 'refs/tags/release ' + tag + ' refs/tags/release ' + '0' * 40
        self.assertEqual(len(MODULE['check_push'](self.root, self.policy, updates)), 1)

    def test_merge_cannot_hide_side_branch_retired_changes(self):
        self.git('checkout', '-qb', 'side')
        (self.root / 'old/runtime.txt').write_text('side edit')
        self.git('add', 'old/runtime.txt')
        self.git('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'side edit')
        side = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '-qb', 'target', self.policy['baseline_commit'])
        self.git('-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '-qm', 'merge side', 'side')
        revision = self.git('rev-parse', 'HEAD').strip()
        updates = 'refs/heads/target ' + revision + ' refs/heads/target ' + '0' * 40
        findings = MODULE['check_push'](self.root, self.policy, updates)
        self.assertIn(side, {row['commit'] for row in findings})
        self.assertIn(revision, {row['commit'] for row in findings})

    def test_policy_rejects_escape_wildcards_and_floating_baselines(self):
        path = self.root / 'policy.json'
        for name in ['../old', '/old', 'old/*', './old', 'old//child']:
            with self.subTest(name=name):
                self.policy['paths'][0]['path'] = name
                path.write_text(json.dumps(self.policy))
                with self.assertRaises(ValueError):
                    MODULE['read_policy'](path)
        self.policy['paths'][0]['path'] = 'old'
        self.policy['baseline_commit'] = 'main'
        path.write_text(json.dumps(self.policy))
        with self.assertRaises(ValueError):
            MODULE['read_policy'](path)


if __name__ == '__main__':
    unittest.main()
