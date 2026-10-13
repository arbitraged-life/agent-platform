"""Configuration contracts for the opt-in quality tooling."""
import json
from pathlib import Path
import os
import unittest

ROOT = Path(__file__).resolve().parents[1]

class QualityToolsTests(unittest.TestCase):
    def test_knip_covers_every_manifest(self):
        package = json.loads((ROOT / "package.json").read_text())
        config_path = "_config/knip.json" if (ROOT / "_config").is_dir() else "knip.json"
        config = json.loads((ROOT / config_path).read_text())
        ignored = {".git", ".venv", "node_modules", "_state", ".agents", ".turbo", ".artifacts", "dist", "__pycache__"}
        expected = set()
        for directory, children, filenames in os.walk(ROOT):
            children[:] = [name for name in children if name not in ignored]
            if "package.json" in filenames:
                expected.add(str(Path(directory).relative_to(ROOT)))
        self.assertEqual(set(config["workspaces"]), expected)
        self.assertIn("--no-exit-code", package["scripts"]["lint:knip:report"])
        self.assertNotIn("--no-exit-code", package["scripts"]["lint:knip"])
        self.assertNotIn("--fix", package["scripts"]["lint:knip"])

    def test_turbo_only_caches_the_source_report(self):
        config = json.loads((ROOT / "turbo.json").read_text())
        self.assertEqual(set(config["tasks"]), {"lint:knip:report"})
        self.assertEqual(config["tasks"]["lint:knip:report"]["inputs"], ["$TURBO_DEFAULT$"])
        self.assertIn("QUALITY_CACHE_RUNTIME", config["globalEnv"])
        knip_path = "_config/knip.json" if (ROOT / "_config").is_dir() else "knip.json"
        workspaces = json.loads((ROOT / knip_path).read_text())["workspaces"]
        self.assertEqual(set(config["globalDependencies"]), {str(Path(name) / "node_modules/.package-lock.json") for name in workspaces})
        runner = (ROOT / "scripts/quality-cache.mjs").read_text()
        self.assertIn("--cache=local:rw", runner)
        self.assertIn("process.version", runner)
        self.assertIn("process.arch", runner)
        self.assertIn("process.platform", runner)

    def test_existing_test_entrypoint_is_not_cached(self):
        package = json.loads((ROOT / "package.json").read_text())
        self.assertNotIn("turbo", package["scripts"]["test"])
        self.assertNotIn("turbo", (ROOT / "scripts/validate").read_text())

if __name__ == "__main__":
    unittest.main()
