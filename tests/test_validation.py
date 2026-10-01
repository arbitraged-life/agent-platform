from importlib.machinery import SourceFileLoader
from importlib.util import spec_from_loader, module_from_spec
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/validate'
SPEC = spec_from_loader('validation', SourceFileLoader('validation', str(SCRIPT)))
validation = module_from_spec(SPEC)
SPEC.loader.exec_module(validation)


class BoundaryTests(unittest.TestCase):
    def test_relative_imports_are_resolved_against_the_containing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'entry.mjs'
            with patch.object(validation, 'ROOT', root):
                file.write_text("import '../private/module.mjs';\n")
                self.assertTrue(validation.boundaries([file]))
                file.write_text("import './runtime/module.mjs';\n")
                self.assertEqual(validation.boundaries([file]), [])

    def test_local_and_floating_package_dependencies_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'package.json'
            with patch.object(validation, 'ROOT', root):
                for version in ['file:../private', 'latest', '^1.2.3', 'github:owner/repo#main']:
                    file.write_text('{"dependencies":{"module":"' + version + '"}}')
                    self.assertTrue(validation.boundaries([file]))
                file.write_text('{"dependencies":{"module":"1.2.3"}}')
                self.assertEqual(validation.boundaries([file]), [])


if __name__ == '__main__':
    unittest.main()
