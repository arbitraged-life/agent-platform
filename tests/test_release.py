import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch, Mock
import os
# qlty-ignore(bandit:B404): Required CLI execution uses argv arrays without a shell.
import subprocess
import shutil
import sys
import time


GIT_EXECUTABLE = shutil.which('git')

SPEC = importlib.util.spec_from_file_location('release', Path(__file__).resolve().parents[1] / 'scripts/platform-release.py')
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_windows_reserved_and_aliased_path_components_are_rejected(self):
        for component in ['CON', 'CON .txt', 'COM1 .log', 'NUL.txt', 'aux', 'COM1', 'lpt9.log', 'COM¹.txt', 'CONIN$', 'name.', 'name ', 'a?b']:
            with self.subTest(component=component), self.assertRaisesRegex(ValueError, 'Unsafe release'):
                release.release_path('nested/' + component + '/file.txt')
        self.assertEqual(str(release.release_path('nested/console.txt')), 'nested/console.txt')

    @unittest.skipUnless(GIT_EXECUTABLE, "Git is required only for release building")
    def test_build_uses_committed_bytes_even_with_hidden_worktree_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'repo'
            root.mkdir()
            # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
            subprocess.run([GIT_EXECUTABLE, 'init', '-q', str(root)], check=True)
            source = root / 'main.txt'
            source.write_text('committed')
            hook = root / '.githooks/pre-commit'
            hook.parent.mkdir()
            hook.write_text('#!/bin/sh\nexit 1\n')
            hook.chmod(0o755)
            # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
            subprocess.run([GIT_EXECUTABLE, '-C', str(root), 'add', 'main.txt', '.githooks/pre-commit'], check=True)
            # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
            subprocess.run([GIT_EXECUTABLE, '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'test'], check=True)
            # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
            subprocess.run([GIT_EXECUTABLE, '-C', str(root), 'update-index', '--assume-unchanged', 'main.txt'], check=True)
            source.write_text('uncommitted')
            first, second = Path(tmp) / 'first.tar', Path(tmp) / 'second.tar'
            release.build(root, first)
            self.assertEqual(first.stat().st_mode & 0o777, 0o644)
            # qlty-ignore(bandit:B603): Fixture changes only its local Git archive configuration.
            subprocess.run([GIT_EXECUTABLE, '-C', str(root), 'config', 'tar.umask', '0777'], check=True)
            release.build(root, second)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            with tarfile.open(first) as archive:
                self.assertEqual(archive.extractfile('main.txt').read(), b'committed')
                self.assertEqual(archive.getmember('.githooks/pre-commit').mode, 0o755)
            installed = release.install(first, release.build(root, first), Path(tmp) / 'installed')
            self.assertTrue(os.access(installed / '.githooks/pre-commit', os.X_OK))
            with patch.object(release, 'MAX_RELEASE_BYTES', 64, create=True), self.assertRaisesRegex(ValueError, 'size limit'):
                release.build(root, Path(tmp) / 'too-large.tar')
            previous = Path(tmp) / 'existing.tar'
            previous.write_bytes(b'previous verified artifact')
            with patch.object(release, 'MAX_RELEASE_BYTES', 4096, create=True), self.assertRaisesRegex(ValueError, 'size limit'):
                release.build(root, previous)
            self.assertEqual(previous.read_bytes(), b'previous verified artifact')

    def test_oversized_header_rejected_before_waiting_for_archive_body(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            git = root / 'git-fixture'
            git.write_text(f"#!{sys.executable}\n" + "import sys, tarfile, time\n"
                           "if 'status' in sys.argv: sys.exit(0)\n"
                           "if 'rev-parse' in sys.argv: print('a' * 40); sys.exit(0)\n"
                           "header = tarfile.TarInfo('huge.bin'); header.size = 100 * 1024 * 1024\n"
                           "sys.stdout.buffer.write(header.tobuf() + bytes(10240)); sys.stdout.buffer.flush()\n"
                           "time.sleep(30)\n")
            git.chmod(0o755)
            started = time.monotonic()
            with patch.object(release, 'GIT_EXECUTABLE', str(git)), self.assertRaisesRegex(ValueError, 'size limit'):
                release.build(root, root / 'release.tar')
            self.assertLess(time.monotonic() - started, 5)
            self.assertFalse((root / 'release.tar').exists())

    def test_input_directory_plus_9999_files_fits_output_manifest_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            git = root / 'git-fixture'
            git.write_text(f"#!{sys.executable}\n" + "import sys, tarfile\n"
                           "if 'status' in sys.argv: sys.exit(0)\n"
                           "if 'rev-parse' in sys.argv: print('a' * 40); sys.exit(0)\n"
                           "with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as archive:\n"
                           " directory=tarfile.TarInfo('src'); directory.type=tarfile.DIRTYPE; archive.addfile(directory)\n"
                           " for index in range(9999): archive.addfile(tarfile.TarInfo('src/file-'+str(index)))\n")
            git.chmod(0o755)
            with patch.object(release, 'GIT_EXECUTABLE', str(git)):
                lock = release.build(root, root / 'release.tar')
            with tarfile.open(root / 'release.tar') as archive:
                self.assertEqual(len(archive.getmembers()), 10000)
            self.assertEqual(lock['commit'], 'a' * 40)

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

    def test_build_rejects_aliases_even_on_a_case_sensitive_source(self):
        for names in [('Foo/a', 'foo/b'), ('caf\u00e9/a', 'cafe\u0301/b'), ('Release-manifest.json', 'other'), ('release-manifest.json/child', 'other')]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as tmp:
                payload = io.BytesIO()
                with tarfile.open(fileobj=payload, mode='w') as archive:
                    for name in names:
                        archive.addfile(tarfile.TarInfo(name))
                process = Mock(stdout=io.BytesIO(payload.getvalue()))
                process.wait.return_value = 0
                process.poll.return_value = 0
                with patch.object(release, 'GIT_EXECUTABLE', '/mock/git'), patch.object(release.subprocess, 'check_output', side_effect=['', 'a' * 40]), patch.object(release.subprocess, 'Popen', return_value=process):
                    with self.assertRaisesRegex(ValueError, 'path alias'):
                        release.build(Path(tmp), Path(tmp) / 'release.tar')
                self.assertFalse((Path(tmp) / 'release.tar').exists())

    def test_case_and_unicode_aliases_are_rejected_before_install(self):
        for left, right in [('Foo/a', 'foo/b'), ('caf\u00e9/a', 'cafe\u0301/b'), ('File', 'file')]:
            with self.subTest(left=left), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                bundle, lock = self.bundle(root, [(left, b'a'), (right, b'b')])
                with self.assertRaisesRegex(ValueError, 'path alias'):
                    release.install(bundle, lock, root / 'installed')
                self.assertEqual(list((root / 'installed').iterdir()), [])

    def test_install_is_verified_and_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            self.assertEqual((target / 'runtime/main.mjs').read_text(), 'export const version = 1;\n')
            with self.assertRaisesRegex(ValueError, 'already exists'):
                release.install(bundle, lock, root / 'installed')

    def test_release_installation_receipt_requires_matching_bundle_and_installed_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            installed = root / 'installed'
            target = release.install(bundle, lock, installed)
            receipt = release.verify_installation(bundle, lock, installed)
            self.assertEqual(receipt['status'], 'installed-bytes-verified')
            self.assertEqual(receipt['source_commit'], lock['commit'])
            self.assertEqual(receipt['release_sha256'], lock['sha256'])
            self.assertEqual(receipt['verified_files'], 1)
            self.assertIsNone(receipt['runtime_deployed'])
            self.assertIsNone(receipt['runtime_accepted'])
            installed_file = target / 'runtime/main.mjs'
            original = installed_file.read_bytes()
            installed_file.write_bytes(b'X' + original[1:])  # same length, different digest
            with self.assertRaisesRegex(ValueError, 'content mismatch'):
                release.verify_installation(bundle, lock, installed)

    def test_cli_verify_accepts_lock_pinned_colocated_bundle_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            release.install(bundle, lock, root / 'installed')
            lock_path = root / 'release.lock.json'
            lock_path.write_text(json.dumps(lock))
            def verify(bundle_path, lock_file):
                argv = ['platform-release.py', 'verify', '--bundle', str(bundle_path),
                        '--lock', str(lock_file), '--destination', str(root / 'installed')]
                output = io.StringIO()
                with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', output):
                    release.main()
                return json.loads(output.getvalue())
            valid = verify(bundle, lock_path)
            self.assertEqual(valid['status'], 'installed-bytes-verified')
            another = root / 'another'
            another.mkdir()
            foreign_lock = another / 'release.lock.json'
            foreign_lock.write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'must share the trusted lock directory'):
                verify(bundle, foreign_lock)
            with self.assertRaisesRegex(ValueError, 'Invalid release artifact name'):
                release.validate_lock({**lock, 'artifact': '..\\unsafe.tar'})

    def test_release_readback_refuses_permission_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            (target / 'runtime/main.mjs').chmod(0o755)
            with self.assertRaisesRegex(ValueError, 'permission mismatch'):
                release.verify_installation(bundle, lock, root / 'installed')

    def test_release_readback_rejects_oversized_installed_file_without_reading_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            with (target / 'runtime/main.mjs').open('wb') as stream:
                stream.truncate(release.MAX_RELEASE_BYTES + 1024)
            with self.assertRaisesRegex(ValueError, 'size mismatch'):
                release.verify_installation(bundle, lock, root / 'installed')

    def test_installation_refuses_platform_without_posix_permission_guarantees(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            with patch.object(release.os, 'name', 'nt'):
                with self.assertRaisesRegex(RuntimeError, 'require POSIX'):
                    release.install(bundle, lock, root / 'installed')
                with self.assertRaisesRegex(RuntimeError, 'require POSIX'):
                    release.verify_installation(bundle, lock, root / 'installed')

    def test_release_readback_refuses_setuid_or_setgid_permission_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            file = target / 'runtime/main.mjs'
            file.chmod(0o4644)
            self.assertEqual(file.stat().st_mode & 0o4000, 0o4000)
            with self.assertRaisesRegex(ValueError, 'permission mismatch'):
                release.verify_installation(bundle, lock, root / 'installed')
            # Some macOS filesystems clear setgid automatically. Verify the
            # denial whenever the filesystem actually preserves that bit.
            file.chmod(0o2644)
            if file.stat().st_mode & 0o2000:
                with self.assertRaisesRegex(ValueError, 'permission mismatch'):
                    release.verify_installation(bundle, lock, root / 'installed')
            file.chmod(0o644)
            self.assertEqual(release.verify_installation(bundle, lock, root / 'installed')['status'],
                             'installed-bytes-verified')

    def test_release_readback_refuses_unexpected_files_and_corrupt_bundle(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            (target / 'unexpected.txt').write_text('untracked')
            with self.assertRaisesRegex(ValueError, 'inventory'):
                release.verify_installation(bundle, lock, root / 'installed')
            (target / 'unexpected.txt').unlink()
            bundle.write_bytes(bundle.read_bytes() + b'tampered')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                release.verify_installation(bundle, lock, root / 'installed')

    def test_corruption_denied(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            bundle.write_bytes(bundle.read_bytes() + b'corrupt')
            with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                release.install(bundle, lock, root / 'installed')
            self.assertFalse((root / 'installed').exists())

    def test_archive_mode_bits_are_clamped_to_canonical_values_on_install(self):
        """Non-standard archive modes must be clamped, not propagated to disk."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = b'content'
            manifest = {'schema_version': 1, 'commit': 'a' * 40,
                        'files': {'runtime/main.mjs': release.sha(data)}}
            bundle = root / 'bundle.tar'
            with tarfile.open(bundle, 'w') as archive:
                # Set a non-canonical mode (0o700 - has execute bit, neither 0o644 nor 0o755).
                for name, content in [('runtime/main.mjs', data),
                                      ('release-manifest.json', json.dumps(manifest).encode())]:
                    info = tarfile.TarInfo(name)
                    info.size = len(content)
                    info.mode = 0o700
                    archive.addfile(info, io.BytesIO(content))
            lock = {'schema_version': 1, 'commit': 'a' * 40,
                    'sha256': release.sha(bundle.read_bytes()), 'artifact': bundle.name}
            target = release.install(bundle, lock, root / 'installed')
            installed_file = target / 'runtime/main.mjs'
            actual_mode = installed_file.stat().st_mode & 0o777
            # 0o700 has execute bit set, so canonical mode must be 0o755, not 0o700.
            self.assertEqual(actual_mode, 0o755)
            self.assertNotEqual(actual_mode, 0o700)


    def test_traversal_duplicates_and_wrong_manifests_leave_no_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for names in [[('../escape', b'x')], [('C:/outside', b'x')], [('C:relative', b'x')], [('runtime/main.mjs:stream', b'x')], [('/absolute', b'x')], [('same', b'x'), ('same', b'y')]]:
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
