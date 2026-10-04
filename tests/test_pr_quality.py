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

    def _valid_body(self):
        return """## Why

This fixes a repeated failure that blocks reliable releases.

## What

Adds a deterministic validator and reusable repository examples.

## Verification

Unit tests passed.

## Risk / Rollback

Low risk; revert the commit to roll back.
"""

    def test_valid_contract(self):
        self.assertEqual(
            self.m.validate(
                "feat(pr): add deterministic PR checks",
                self._valid_body(),
                self.m.DEFAULT,
            ),
            [],
        )

    def test_missing_semantic_section_fails(self):
        body = """## What

A sufficiently detailed description of the change.

## Verification

Tests pass.

## Risk / Rollback

Revert safely.
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

    def test_fenced_headings_do_not_count_as_sections(self):
        fence = chr(96) * 3
        body = (
            fence + "md\n## Why\nfake\n## What\nfake\n## Verification\nfake\n"
            "## Risk / Rollback\nfake\n" + fence + "\n"
        )
        errors = self.m.validate("feat(pr): add deterministic PR checks", body, self.m.DEFAULT)
        self.assertTrue(any("missing required section: ## Why" in error for error in errors))

    def test_duplicate_required_heading_fails(self):
        body = self._valid_body() + "\n## Why\n\nAnother sufficiently long rationale.\n"
        errors = self.m.validate("feat(pr): add deterministic PR checks", body, self.m.DEFAULT)
        self.assertTrue(any("duplicate required section: ## Why" in error for error in errors))

    def test_minimum_keys_are_normalized_like_required_headings(self):
        config = self.m.load_config(None)
        config["required_sections"] = [" why "]
        config["minimum_section_characters"] = {"Why": 20}
        errors = self.m.validate(
            "feat(pr): add deterministic PR checks",
            "## WHY\n\nshort\n",
            config,
        )
        self.assertTrue(any("minimum is 20" in error for error in errors))

    def test_non_object_config_is_rejected(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json") as fh:
            fh.write("[]")
            fh.flush()
            with self.assertRaises(ValueError):
                self.m.load_config(Path(fh.name))


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

    def test_non_object_and_unknown_advisory_config_are_rejected(self):
        for payload in ([], {"schema_version": 1, "advisory": {"typo_ratio": 1}}):
            with self.subTest(payload=payload), tempfile.NamedTemporaryFile("w", suffix=".json") as fh:
                json.dump(payload, fh)
                fh.flush()
                with self.assertRaises(ValueError):
                    self.m.load_config(Path(fh.name))

    def test_common_test_file_names_are_classified(self):
        for name in ("pkg/test_widget.py", "pkg/widget_test.py", "pkg/widget_test.go"):
            with self.subTest(name=name):
                self.assertTrue(self.m.is_test_path(name))

    def test_header_files_count_as_source(self):
        diff = """diff --git a/include/widget.hpp b/include/widget.hpp
--- a/include/widget.hpp
+++ b/include/widget.hpp
@@
+int widget();
"""
        self.assertEqual(self.m.measure(diff)["source_additions"], 1)

    def test_language_aware_comments_do_not_count_preprocessor_or_rust_attributes(self):
        c_diff = """diff --git a/src/a.c b/src/a.c
--- a/src/a.c
+++ b/src/a.c
@@
+#include <stdio.h>
+// actual comment
"""
        rs_diff = """diff --git a/src/a.rs b/src/a.rs
--- a/src/a.rs
+++ b/src/a.rs
@@
+#[derive(Debug)]
+// actual comment
"""
        self.assertEqual(self.m.measure(c_diff)["comment_only_additions"], 1)
        self.assertEqual(self.m.measure(rs_diff)["comment_only_additions"], 1)

    def test_quoted_path_with_spaces_is_counted(self):
        diff = """diff --git "a/src/file name.py" "b/src/file name.py"
--- "a/src/file name.py"
+++ "b/src/file name.py"
@@
+value = 1
"""
        metrics = self.m.measure(diff)
        self.assertEqual(metrics["changed_files"], 1)
        self.assertEqual(metrics["additions"], 1)

    def test_added_content_that_looks_like_header_is_counted_inside_hunk(self):
        diff = """diff --git a/src/a.py b/src/a.py
--- a/src/a.py
+++ b/src/a.py
@@
++++ literal content
"""
        self.assertEqual(self.m.measure(diff)["additions"], 1)


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

    def test_double_star_is_valid_catch_all(self):
        self.assertEqual(self.m.validate("** @maintainers\n"), [])

    def test_inline_comment_is_ignored(self):
        self.assertEqual(self.m.validate("* @maintainers #This is an inline comment\n"), [])

    def test_malformed_owner_is_rejected(self):
        for owner in ("@team/a/b", "@@alice", "@alice,"):
            with self.subTest(owner=owner):
                errors = self.m.validate(f"* {owner}\n")
                self.assertTrue(any("invalid owner" in error for error in errors))


class TestExamples(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pr = load("example_pr_contract", "scripts/pr/validate_pr_contract.py")
        cls.budget = load("example_codegen_budget", "scripts/quality/codegen_budget.py")

    def test_example_configs_load_through_validators(self):
        pr_config = self.pr.load_config(ROOT / "examples/pr-quality/pr-contract.json")
        budget_config = self.budget.load_config(ROOT / "examples/pr-quality/codegen-budget.json")
        self.assertEqual(pr_config, self.pr.DEFAULT)
        self.assertEqual(budget_config["schema_version"], 1)

    def test_ci_failure_action_has_required_input_and_redirect_guards(self):
        action = (ROOT / "actions/ci-failure-notify/action.yml").read_text(encoding="utf-8")
        self.assertIn("required action inputs are empty", action)
        self.assertIn("class NoRedirect", action)
        self.assertIn("notification webhook redirects are not allowed", action)


if __name__ == "__main__":
    unittest.main()
