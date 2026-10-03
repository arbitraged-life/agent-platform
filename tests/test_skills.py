"""Pinned skill provenance, discovery, and drift checks."""
import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = runpy.run_path(str(ROOT / 'scripts/skills.py'))


class SkillTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for name in ['skills', 'licenses']:
            shutil.copytree(ROOT / name, self.root / name)
        shutil.copyfile(ROOT / 'LICENSE', self.root / 'LICENSE')

    def edit(self, name, action):
        path = self.root / name
        data = json.loads(path.read_text())
        action(data)
        path.write_text(json.dumps(data))

    def test_discovery_and_installed_hashes(self):
        rows = MODULE['catalog'](self.root)
        self.assertEqual(len(rows), 28)
        lock = MODULE['verify_upstream'](self.root)
        self.assertEqual(len(lock['files']), 358)
        self.assertEqual(len(lock['overlays']), 10)

    def test_fresh_migration_replacements_are_bundled_and_bounded(self):
        rows = {row["name"]: row for row in MODULE["catalog"](self.root)}
        expected = {
            "acquire-codebase-knowledge",
            "autonomous-pr-integration",
            "evaluating-new-projects",
            "javascript-typescript-jest",
            "session-close-out",
        }
        self.assertTrue(expected.issubset(rows))
        for name in expected:
            self.assertEqual(rows[name]["license"], "LICENSE")

        pr = (self.root / "skills/autonomous-pr-integration/SKILL.md").read_text()
        self.assertIn("exact revision", pr)
        self.assertIn("does not expand authority", pr)
        self.assertIn("stale successful check", pr)

        jest = (self.root / "skills/javascript-typescript-jest/SKILL.md").read_text()
        self.assertIn("jest.clearAllMocks()", jest)
        self.assertIn("jest.resetAllMocks()", jest)
        self.assertIn("jest.restoreAllMocks()", jest)

        evaluation = (self.root / "skills/evaluating-new-projects/SKILL.md").read_text()
        self.assertIn("Do not install a candidate globally", evaluation)
        self.assertIn("same inputs and measurement method", evaluation)

        closeout = (self.root / "skills/session-close-out/SKILL.md").read_text()
        self.assertIn("Never claim coverage", closeout)
        self.assertIn("do not clean, reset, stash, commit, or push", closeout)

        knowledge = (self.root / "skills/acquire-codebase-knowledge/SKILL.md").read_text()
        self.assertIn("git ls-files", knowledge)
        self.assertIn("Do not follow symlinks", knowledge)
        self.assertIn("Do not read entire large files", knowledge)

    def test_generic_wrapper_replacements_are_bounded(self):
        rows = {row["name"]: row for row in MODULE["catalog"](self.root)}
        for name in {"headroom", "markitdown", "officecli"}:
            self.assertIn(name, rows)
            self.assertEqual(rows[name]["license"], "LICENSE")

        headroom = (self.root / "skills/headroom/SKILL.md").read_text()
        self.assertIn("Do not repeat vendor benchmark claims as local evidence", headroom)
        self.assertIn("proxy or agent wrapper", headroom)

        markitdown = (self.root / "skills/markitdown/SKILL.md").read_text()
        self.assertIn("empty output is not success", markitdown)
        self.assertIn("Do not silently upload private documents", markitdown)

        office = (self.root / "skills/officecli/SKILL.md").read_text()
        self.assertIn("Do not run vendor", office)
        self.assertIn("Read the modified element back", office)
        self.assertIn("Persistent agent configuration", office)

    def test_generic_policy_replacements_fail_closed(self):
        rows = {row["name"]: row for row in MODULE["catalog"](self.root)}
        for name in {"cross-language-purity", "prompt-refiner", "ultragrokking-articles"}:
            self.assertIn(name, rows)
            self.assertEqual(rows[name]["license"], "LICENSE")

        purity = (self.root / "skills/cross-language-purity/SKILL.md").read_text()
        self.assertIn("Fail closed", purity)
        self.assertIn("private hook names", purity)

        refiner = (self.root / "skills/prompt-refiner/SKILL.md").read_text()
        self.assertIn("does not grant additional authority", refiner)
        self.assertIn("Do not write them to logs", refiner)

        grok = (self.root / "skills/ultragrokking-articles/SKILL.md").read_text()
        self.assertIn("not a mandatory one", grok)
        self.assertIn("false-positive risk", grok)

    def test_behavior_policy_replacements_preserve_safety_and_scope(self):
        rows = {row["name"]: row for row in MODULE["catalog"](self.root)}
        for name in {"caveman", "i-have-adhd", "ponytail"}:
            self.assertIn(name, rows)
            self.assertEqual(rows[name]["license"], "LICENSE")

        caveman = (self.root / "skills/caveman/SKILL.md").read_text()
        self.assertIn("does not persist user state", caveman)
        self.assertIn("destructive-action warnings", caveman)

        action_first = (self.root / "skills/i-have-adhd/SKILL.md").read_text()
        self.assertIn("Do not invent time estimates", action_first)
        self.assertIn("output preference", action_first)

        ponytail = (self.root / "skills/ponytail/SKILL.md").read_text()
        self.assertIn("root cause", ponytail)
        self.assertIn("security controls", ponytail)
        self.assertIn("rather than line count alone", ponytail)

    def test_original_skill_references_are_validated(self):
        path = self.root / 'skills/repository-safe-cleanup/SKILL.md'
        path.write_text(path.read_text() + '\n[Missing helper](../missing/SKILL.md)\n')
        validator = runpy.run_path(str(ROOT / 'scripts/validate'))
        with self.assertRaisesRegex(ValueError, 'Broken bundled skill reference'):
            validator['validate_skills'](self.root)

    def test_catalog_duplicates_and_escape_are_rejected(self):
        self.edit('skills/catalog.json', lambda d: d['skills'].append(d['skills'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            MODULE['catalog'](self.root)
        for name in ['../LICENSE', '/LICENSE', 'skills/../LICENSE']:
            with self.assertRaises(ValueError):
                MODULE['contained_file'](self.root, name)

    def test_drift_cannot_be_hidden_by_updating_only_the_file_hash(self):
        name = 'skills/wrangler/SKILL.md'
        path = self.root / name
        path.write_text(path.read_text() + '\nUnreviewed change\n')
        with self.assertRaisesRegex(ValueError, 'content changed'):
            MODULE['verify_upstream'](self.root)
        self.edit('skills/upstream-lock.json', lambda d: d['files'][name].update(sha256=MODULE['sha'](path)))
        with self.assertRaisesRegex(ValueError, 'explicit overlay'):
            MODULE['verify_upstream'](self.root)

    def test_omitted_and_extra_files_fail(self):
        extra = self.root / 'skills/wrangler/unreviewed.md'
        extra.write_text('not in the release inventory')
        with self.assertRaisesRegex(ValueError, 'inventory changed'):
            MODULE['verify_upstream'](self.root)
        extra.unlink()
        (self.root / 'skills/wrangler/SKILL.md').unlink()
        with self.assertRaises(ValueError):
            MODULE['verify_upstream'](self.root)

    def test_missing_license_and_unpinned_source_fail(self):
        self.edit('skills/upstream-lock.json', lambda d: d.update(commit='main'))
        with self.assertRaisesRegex(ValueError, 'immutable'):
            MODULE['verify_upstream'](self.root)
        (self.root / 'licenses/cloudflare-skills-LICENSE').unlink()
        with self.assertRaises(ValueError):
            MODULE['catalog'](self.root)


if __name__ == '__main__':
    unittest.main()
