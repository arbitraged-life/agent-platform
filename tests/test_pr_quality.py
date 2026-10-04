#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestPrContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load("pr_contract", "scripts/pr/validate_pr_contract.py")

    def test_valid_contract(self):
        body = """## Why

This fixes a repeated failure that blocks reliable releases.

## What

Adds a deterministic validator and reusable repository examples.

## Verification

Unit tests passed.

## Risk / Rollback

Low risk; revert the commit to roll back.
"""
        self.assertEqual(
            self.m.validate("feat(pr): add deterministic PR checks", body, self.m.DEFAULT),
            [],
        )

    def test_missing_semantic_section_fails(self):
        body = """## What

A sufficiently detailed description of the change.

## Verification

Tests pass.

## Risk / Rollback

Revert.
"""
        errors = self.m.validate("feat(pr): add deterministic PR checks", body, self.m.DEFAULT)
        self.assertTrue(any("## Why" in error for error in errors))

    def test_comments_do_not_satisfy_minimum_length(self):
        body = """## Why

<!-- model should replace this placeholder -->

## What

A sufficiently detailed description of the change.

## Verification

Tests pass.

## Risk / Rollback

Revert safely.
"""
        errors = self.m.validate("feat(pr): add deterministic PR checks", body, self.m.DEFAULT)
        self.assertTrue(any("## Why" in error for error in errors))


class TestCodegenBudget(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load("codegen_budget", "scripts/quality/codegen_budget.py")

    def test_measures_diff(self):
        diff = """diff --git a/src/a.py b/src/a.py
--- a/src/a.py
+++ b/src/a.py
@@
+value = 1
+# explanatory comment
-old = 1
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@
+def test_a():
+    assert True
"""
        metrics = self.m.measure(diff)
        self.assertEqual(metrics["changed_files"], 2)
        self.assertEqual(metrics["additions"], 4)
        self.assertEqual(metrics["deletions"], 1)
        self.assertEqual(metrics["comment_only_additions"], 1)
        self.assertEqual(metrics["test_additions"], 2)
        self.assertEqual(metrics["source_additions"], 2)

    def test_hard_budget_fails(self):
        metrics = {
            "changed_files": 2,
            "additions": 10,
            "deletions": 0,
            "total_changes": 10,
            "max_single_file_additions": 10,
            "comment_only_additions": 0,
            "comment_only_addition_ratio": 0.0,
            "test_additions": 0,
            "source_additions": 10,
            "test_to_source_addition_ratio": 0.0,
        }
        config = {
            "schema_version": 1,
            "hard": {
                "max_changed_files": 1,
                "max_additions": 100,
                "max_deletions": 100,
                "max_total_changes": 200,
                "max_single_file_additions": 100,
            },
            "advisory": self.m.DEFAULT["advisory"],
        }
        errors, _ = self.m.evaluate(metrics, config)
        self.assertTrue(any("changed_files" in error for error in errors))

    def test_comment_ratio_is_advisory(self):
        metrics = {
            "changed_files": 1,
            "additions": 10,
            "deletions": 0,
            "total_changes": 10,
            "max_single_file_additions": 10,
            "comment_only_additions": 8,
            "comment_only_addition_ratio": 0.8,
            "test_additions": 0,
            "source_additions": 2,
            "test_to_source_addition_ratio": 0.0,
        }
        errors, warnings = self.m.evaluate(metrics, self.m.DEFAULT)
        self.assertEqual(errors, [])
        self.assertTrue(any("comment_only" in warning for warning in warnings))


class TestCodeowners(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load("codeowners", "scripts/pr/validate_codeowners.py")

    def test_realistic_codeowners_passes(self):
        text = "* @example-maintainers\nsrc/ @frontend-reviewers\n"
        self.assertEqual(self.m.validate(text), [])

    def test_placeholder_and_missing_catch_all_fail(self):
        errors = self.m.validate("src/ @ORG/frontend\n")
        self.assertTrue(any("placeholder" in error for error in errors))
        self.assertTrue(any("catch-all" in error for error in errors))


class TestExamples(unittest.TestCase):
    def test_example_configs_parse(self):
        for relative in (
            "examples/pr-quality/pr-contract.json",
            "examples/pr-quality/codegen-budget.json",
        ):
            doc = json.loads((ROOT / relative).read_text(encoding="utf-8"))
            self.assertEqual(doc["schema_version"], 1)


if __name__ == "__main__":
    unittest.main()
