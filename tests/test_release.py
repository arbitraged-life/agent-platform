import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import subprocess

SPEC = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[1] / 'scripts/platform-release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_build_uses_committed_bytes_even_with_hidden_worktree_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            root.mkdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            source = root / 'main.txt'
            source.write_text('committed')
            subprocess.run(['git', '-C', str(root), 'add', 'main.txt'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test'], check=True)
            subprocess.run(['git', '-C', str(root), 'update-index', '--assume-unchanged', 'main.txt'], check=True)
            source.write_text('uncommitted')
            first, second = Path(tmp) / 'first.tar', Path(tmp) / 'second.tar'
            release.build(root, first)
            release.build(root, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                self.assertEqual(archive.extractfile('main.txt').read(), b'committed')

    def bundle(self, root, names=None, wrong_manifest=False):
        data = b'export const version = 1;\n'
        manifest = {'schema_version': 1, 'commit': 'a' * 40, 'files': {'runtime/main.mjs': release.sha(data)}}
        if wrong_manifest:
            manifest['files']['runtime/main.mjs'] = 'b' * 64
        bundle = root / 'bundle.tar'
        with tarfile.open(bundle, 'w') as archive:
            for name, content in (names or [('runtime/main.mjs', data)]) + [('release-manifest.json', json.dumps(manifest).encode())]:
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        return bundle, {'schema_version': 1, 'commit': 'a' * 40, 'sha256': release.sha(bundle.read_bytes()), 'artifact': bundle.name}

    def test_install_is_verified_and_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            self.assertEqual((target / 'runtime/main.mjs').read_text(), 'export const version = 1;\n')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                release.install(bundle, lock, root / 'installed')

    def test_corruption_never_creates_an_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            bundle.write_bytes(bundle.read_bytes() + b'corrupt')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                release.install(bundle, lock, root / 'installed')
            self.assertFalse((root / 'installed').exists())

    def test_traversal_duplicates_and_wrong_manifests_leave_no_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for names in [[('../escape', b'x')], [('/absolute', b'x')], [('same', b'x'), ('same', b'y')]]:
                bundle, lock = self.bundle(root, names)
                with self.assertRaisesRegex(ValueError, 'Unsafe'):
                    release.install(bundle, lock, root / 'installed')
                self.assertEqual(list((root / 'installed').iterdir()), [])
            bundle, lock = self.bundle(root, wrong_manifest=True)
            with self.assertRaisesRegex(ValueError, 'manifest mismatch'):
                release.install(bundle, lock, root / 'installed')
            self.assertEqual(list((root / 'installed').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
