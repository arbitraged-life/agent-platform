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
            pinned_digest = release.sha(lock_path.read_bytes())
            def verify(bundle_path, lock_file, expected_digest=pinned_digest):
                argv = ['platform-release.py', 'verify', '--bundle', str(bundle_path),
                        '--lock', str(lock_file), '--expected-lock-sha256', expected_digest,
                        '--destination', str(root / 'installed')]
                output = io.StringIO()
                with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', output):
                    release.main()
                return json.loads(output.getvalue())
            valid = verify(bundle, lock_path)
            self.assertEqual(valid['status'], 'installed-bytes-verified')
            with self.assertRaisesRegex(ValueError, 'digest or size mismatch'):
                verify(bundle, lock_path, '0' * 64)
            with self.assertRaisesRegex(ValueError, 'independently pinned'):
                verify(bundle, lock_path, '')
            another = root / 'another'
            another.mkdir()
            foreign_lock = another / 'release.lock.json'
            foreign_lock.write_text(json.dumps(lock))
            with self.assertRaisesRegex(ValueError, 'same explicit directory'):
                verify(bundle, foreign_lock)
            with self.assertRaisesRegex(ValueError, 'Invalid release artifact name'):
                release.validate_lock({**lock, 'artifact': '..\\unsafe.tar'})

    def test_cli_rejects_destinations_outside_pinned_lock_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            trusted = Path(tmp) / 'trusted'
            trusted.mkdir()
            bundle, lock = self.bundle(trusted)
            lock_path = trusted / 'release.lock.json'
            lock_path.write_text(json.dumps(lock))
            pin = release.sha(lock_path.read_bytes())
            outside = Path(tmp) / 'outside'
            outside.mkdir()

            def invoke(command, destination):
                argv = ['platform-release.py', command, '--bundle', str(bundle),
                        '--lock', str(lock_path), '--expected-lock-sha256', pin,
                        '--destination', str(destination)]
                with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', io.StringIO()):
                    release.main()

            for command in ('install', 'verify'):
                with self.subTest(command=command), self.assertRaisesRegex(
                        ValueError, 'inside trusted artifact directory'):
                    invoke(command, outside)
            self.assertEqual(list(outside.iterdir()), [])

            alias = trusted / 'redirect'
            alias.symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'inside trusted artifact directory'):
                invoke('verify', alias)
            with self.assertRaisesRegex(ValueError, 'path traversal'):
                invoke('install', trusted / '..' / 'outside')

    def test_atomic_publication_refuses_concurrent_target_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            destination = root / 'installed'
            publish = release._rename_no_replace
            raced = []

            def create_target_before_publish(stage, commit, directory_fd):
                target = destination / commit
                target.mkdir()
                (target / 'sentinel').write_text('must survive')
                raced.append(True)
                return publish(stage, commit, directory_fd)

            with patch.object(release, '_rename_no_replace',
                              side_effect=create_target_before_publish):
                with self.assertRaises(FileExistsError):
                    release.install(bundle, lock, destination)
            self.assertTrue(raced)
            self.assertEqual((destination / lock['commit'] / 'sentinel').read_text(),
                             'must survive')
            self.assertFalse(list(destination.glob('.install-*')))

    def test_cli_rejects_replaced_destination_inode_after_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            trusted = root / 'trusted'
            trusted.mkdir()
            ancestor = trusted / 'mutable'
            ancestor.mkdir()
            (ancestor / 'installed').mkdir()
            bundle, lock = self.bundle(trusted)
            lock_path = trusted / 'release.lock.json'
            lock_path.write_text(json.dumps(lock))
            argv = ['platform-release.py', 'install', '--bundle', str(bundle),
                    '--lock', str(lock_path),
                    '--expected-lock-sha256', release.sha(lock_path.read_bytes()),
                    '--destination', str(ancestor / 'installed')]
            original_install = release.install
            mutated = []

            def replace_after_validation(*args, **kwargs):
                self.assertIsNotNone(kwargs.get('destination_fd'),
                                     'CLI must pin the validated destination fd')
                ancestor.rename(root / 'moved-ancestor')
                ancestor.mkdir()
                (ancestor / 'installed').mkdir()
                mutated.append(True)
                return original_install(*args, **kwargs)

            with patch.object(sys, 'argv', argv), patch.object(
                    release, 'install', side_effect=replace_after_validation):
                with self.assertRaisesRegex(ValueError, 'destination changed'):
                    release.main()
            self.assertTrue(mutated)
            self.assertFalse((ancestor / 'installed' / lock['commit']).exists())
            self.assertFalse((root / 'moved-ancestor' / 'installed' /
                              lock['commit']).exists())

    def test_install_detects_ancestor_relocation_before_returning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ancestor = root / 'ancestor'
            ancestor.mkdir()
            destination = ancestor / 'installed'
            bundle, lock = self.bundle(root)
            publish = release._rename_no_replace

            def relocate_at_publish(stage, commit, directory_fd):
                ancestor.rename(root / 'relocated-ancestor')
                ancestor.symlink_to(root / 'relocated-ancestor',
                                    target_is_directory=True)
                return publish(stage, commit, directory_fd)

            with patch.object(release, '_rename_no_replace',
                              side_effect=relocate_at_publish):
                with self.assertRaises((ValueError, OSError)):
                    release.install(bundle, lock, destination)
            self.assertTrue(ancestor.is_symlink())
            self.assertTrue((root / 'relocated-ancestor' / 'installed').exists())

    @unittest.skipUnless(sys.platform == 'darwin' or hasattr(os, 'O_PATH') or hasattr(os, 'O_SEARCH'),
                         'Search-only POSIX descriptor support required')
    def test_search_only_ancestor_allows_valid_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            ancestor = root / 'search-only'
            ancestor.mkdir()
            destination = ancestor / 'installed'
            destination.mkdir()
            bundle, lock = self.bundle(root)
            ancestor.chmod(0o111)
            try:
                target = release.install(bundle, lock, destination)
                self.assertTrue((target / 'runtime/main.mjs').is_file())
            finally:
                ancestor.chmod(0o700)

    def test_public_directory_permissions_and_private_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            directory = root / 'installed'
            original_extract = release._extract_bundle
            seen_modes = []

            def check_staging(data, fd):
                seen_modes.append(os.fstat(fd).st_mode & 0o777)
                return original_extract(data, fd)

            with patch.object(release, '_extract_bundle', side_effect=check_staging):
                release.install(bundle, lock, directory, directory_mode=0o755)
            self.assertTrue(directory.stat().st_mode & 0o011,
                            'other accounts must be able to traverse release roots')
            self.assertEqual(seen_modes, [0o700])
            published = directory / lock['commit']
            self.assertEqual(published.stat().st_mode & 0o777, 0o755)
            directory.chmod(0o777)
            with self.assertRaisesRegex(ValueError, 'Unsafe writable release'):
                release.install(bundle, lock, directory)

    def test_directory_mode_defaults_private_and_rejects_unsafe_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            published = release.install(bundle, lock, root / 'private-install')
            self.assertEqual((root / 'private-install').stat().st_mode & 0o777, 0o700)
            self.assertEqual(published.stat().st_mode & 0o777, 0o700)
            for unsafe in (0o777, 0o766, 0, True, None):
                with self.subTest(mode=unsafe), self.assertRaisesRegex(
                        ValueError, 'Unsupported release directory mode'):
                    release.install(bundle, lock, root / 'unsafe-install',
                                    directory_mode=unsafe)

    def test_restrictive_umask_does_not_block_new_directory_creation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            old_umask = os.umask(0o777)
            try:
                published = release.install(bundle, lock,
                                            root / 'subdir/installed',
                                            directory_mode=0o755)
            finally:
                os.umask(old_umask)
            self.assertEqual(published.stat().st_mode & 0o777, 0o755)
            self.assertEqual((root / 'subdir').stat().st_mode & 0o777, 0o755)

    def test_missing_cli_verification_destination_is_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            pin_file = root / 'release.lock.json'
            pin_file.write_text(json.dumps(lock))
            missing = root / 'missing-destination'
            argv = ['platform-release.py', 'verify', '--bundle', str(bundle),
                    '--lock', str(pin_file),
                    '--expected-lock-sha256', release.sha(pin_file.read_bytes()),
                    '--destination', str(missing)]
            with patch.object(sys, 'argv', argv), patch.object(sys, 'stdout', io.StringIO()):
                with self.assertRaises(OSError):
                    release.main()
            self.assertFalse(missing.exists())

    def test_staging_cleanup_failure_is_reported_without_masking_cause(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            def fail_extract(*args):
                raise ValueError('original validation failure')

            with patch.object(release, '_extract_bundle', side_effect=fail_extract):
                with patch.object(release.shutil, 'rmtree', side_effect=OSError(
                        'simulated cleanup failure')):
                    with self.assertRaisesRegex(ValueError, 'original validation failure') as caught:
                        release.install(bundle, lock, root / 'installed')
            self.assertTrue(any('cleanup failed' in note for note in caught.exception.__notes__))

    def test_depth_limit_applies_to_bundle_paths(self):
        too_deep = '/'.join(['nested'] * 33)
        with self.assertRaisesRegex(ValueError, 'Unsafe release entry'):
            release.release_path(too_deep)

    def test_python_install_rejects_bundle_alias_that_verify_would_reject(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            alias = root / 'otherwise-valid-alias.tar'
            shutil.copy2(bundle, alias)
            with self.assertRaisesRegex(ValueError, 'artifact filename mismatch'):
                release.install(alias, lock, root / 'installed')

    def test_receipt_discloses_unknown_python_lock_provenance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            release.install(bundle, lock, root / 'installed')
            self.assertIsNone(release.verify_installation(bundle, lock, root / 'installed')
                              ['lock_origin_authenticated'])

    def test_readback_rejects_growing_file_after_initial_size_check(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            candidate = target / 'runtime/main.mjs'
            inode = candidate.stat().st_ino
            original_fstat = release.os.fstat
            grew = False

            def grow_after_size_check(fd):
                nonlocal grew
                current = original_fstat(fd)
                if current.st_ino == inode and not grew:
                    grew = True
                    with candidate.open('ab') as stream:
                        stream.write(b'x' * 4096)
                return current

            with patch.object(release.os, 'fstat', side_effect=grow_after_size_check):
                with self.assertRaisesRegex(ValueError, 'size changed during readback'):
                    release.verify_installation(bundle, lock, root / 'installed')
            self.assertTrue(grew, 'the test must grow the file after its first size check')

    def test_readback_rejects_nested_file_replacement_after_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            candidate = target / 'runtime/main.mjs'
            original_read = release._read_installed_file
            swapped = False

            def replace_after_hash(directory_fd, component, expected_mode, expected_size):
                nonlocal swapped
                digest = original_read(directory_fd, component, expected_mode, expected_size)
                if component == 'main.mjs' and not swapped:
                    swapped = True
                    candidate.rename(root / 'old-main.mjs')
                    candidate.write_bytes((root / 'old-main.mjs').read_bytes())
                return digest

            with patch.object(release, '_read_installed_file', side_effect=replace_after_hash):
                with self.assertRaisesRegex(ValueError, 'directory changed during readback'):
                    release.verify_installation(bundle, lock, root / 'installed')
            self.assertTrue(swapped)

    def test_readback_rejects_nested_directory_replacement_after_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            nested = target / 'runtime'
            original_entry = release._read_installed_entry
            swapped = False

            def replace_after_open(*args):
                nonlocal swapped
                fd, digest = original_entry(*args)
                if args[1] == 'runtime' and not swapped:
                    swapped = True
                    nested.rename(root / 'old-runtime')
                    shutil.copytree(root / 'old-runtime', nested)
                return fd, digest

            with patch.object(release, '_read_installed_entry', side_effect=replace_after_open):
                with self.assertRaisesRegex(ValueError, 'directory changed during readback'):
                    release.verify_installation(bundle, lock, root / 'installed')
            self.assertTrue(swapped)

    def test_cli_install_rejects_parent_symlink_swap_after_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            trusted = root / 'trusted'
            trusted.mkdir()
            stage = trusted / 'staging'
            stage.mkdir()
            outside = root / 'outside'
            outside.mkdir()
            bundle, lock = self.bundle(trusted)
            lock_path = trusted / 'release.lock.json'
            lock_path.write_text(json.dumps(lock))
            argv = ['platform-release.py', 'install', '--bundle', str(bundle),
                    '--lock', str(lock_path),
                    '--expected-lock-sha256', release.sha(lock_path.read_bytes()),
                    '--destination', str(stage / 'installed')]
            original_install = release.install
            swapped = False

            def install_after_symlink_swap(*args, **kwargs):
                nonlocal swapped
                swapped = True
                stage.rename(root / 'old-staging')
                stage.symlink_to(outside, target_is_directory=True)
                return original_install(*args, **kwargs)

            with patch.object(sys, 'argv', argv), patch.object(release, 'install',
                side_effect=install_after_symlink_swap):
                with self.assertRaises(OSError):
                    release.main()
            self.assertTrue(swapped)
            self.assertEqual(list(outside.iterdir()), [])

    def test_install_rejects_staging_directory_swap_before_atomic_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            dest = root / 'installed'
            outside = root / 'outside'
            outside.mkdir()
            original_extract = release._extract_bundle
            swapped = False

            def swap_staging_after_extract(data, directory_fd):
                nonlocal swapped
                original_extract(data, directory_fd)
                temporary = next(dest.glob('.install-*'))
                temporary.rename(root / 'retired-staging')
                temporary.symlink_to(outside, target_is_directory=True)
                swapped = True

            with patch.object(release, '_extract_bundle',
                              side_effect=swap_staging_after_extract):
                with self.assertRaisesRegex(ValueError, 'staging directory changed'):
                    release.install(bundle, lock, dest)
            self.assertTrue(swapped)
            self.assertEqual(list(outside.iterdir()), [])
            self.assertFalse((dest / lock['commit']).exists())

    def test_release_readback_rejects_installed_symlinked_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            outside = root / 'untrusted'
            outside.mkdir()
            (outside / 'main.mjs').write_text('untrusted')
            (target / 'runtime').rename(root / 'original-runtime')
            (target / 'runtime').symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'symbolic link'):
                release.verify_installation(bundle, lock, root / 'installed')

    def test_release_readback_rejects_parent_symlink_swapped_during_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            outside = root / 'untrusted'
            outside.mkdir()
            (outside / 'main.mjs').write_text('untrusted')
            original_open = release.os.open
            swapped = False

            def swapping_open(path, flags, *args, **kwargs):
                nonlocal swapped
                if not swapped and path == 'runtime' and kwargs.get('dir_fd') is not None:
                    swapped = True
                    (target / 'runtime').rename(root / 'original-runtime')
                    (target / 'runtime').symlink_to(outside, target_is_directory=True)
                return original_open(path, flags, *args, **kwargs)

            with patch.object(release.os, 'open', side_effect=swapping_open):
                with self.assertRaisesRegex(ValueError, 'unsafe or changed path'):
                    release.verify_installation(bundle, lock, root / 'installed')
            self.assertTrue(swapped, 'the test must hit the nested-directory fd open')

    def test_release_readback_rejects_target_symlink_swapped_during_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            outside = root / 'untrusted'
            outside.mkdir()
            original_open = release.os.open
            swapped = False

            def swapping_open(path, flags, *args, **kwargs):
                nonlocal swapped
                if not swapped and path == lock['commit'] and kwargs.get('dir_fd') is not None:
                    swapped = True
                    target.rename(root / 'original-installation')
                    target.symlink_to(outside, target_is_directory=True)
                return original_open(path, flags, *args, **kwargs)

            with patch.object(release.os, 'open', side_effect=swapping_open):
                with self.assertRaisesRegex(ValueError, 'directory is unavailable or unsafe'):
                    release.verify_installation(bundle, lock, root / 'installed')
            self.assertTrue(swapped, 'the test must hit the anchored target-dir open')

    def test_release_lock_and_manifest_reject_noninteger_schema_versions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            for schema in (True, 1.0):
                with self.subTest(schema=schema), self.assertRaisesRegex(ValueError, 'Unsupported release lock'):
                    release.validate_lock({**lock, 'schema_version': schema})
            for schema in (True, 1.0):
                manifest = {'schema_version': schema, 'commit': 'a' * 40,
                            'files': {'runtime/main.mjs': release.sha(b'export const version = 1;\n')}}
                with tarfile.open(bundle, 'w') as archive:
                    for name, content in [('runtime/main.mjs', b'export const version = 1;\n'),
                                          ('release-manifest.json', json.dumps(manifest).encode())]:
                        info = tarfile.TarInfo(name)
                        info.size = len(content)
                        archive.addfile(info, io.BytesIO(content))
                revised = {**lock, 'sha256': release.sha(bundle.read_bytes())}
                with self.subTest(manifest_schema=schema), self.assertRaisesRegex(ValueError, 'manifest identity mismatch'):
                    release.install(bundle, revised, root / 'installed')

    def test_release_readback_rejects_target_swapped_after_hashing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            bundle, lock = self.bundle(root)
            target = release.install(bundle, lock, root / 'installed')
            original_scan = release._scan_installed_release
            def replace_after_scan(*args):
                receipts = original_scan(*args)
                target.rename(root / 'retired-installation')
                (target).symlink_to(root / 'retired-installation', target_is_directory=True)
                return receipts
            with patch.object(release, '_scan_installed_release', side_effect=replace_after_scan):
                with self.assertRaisesRegex(ValueError, 'changed during readback'):
                    release.verify_installation(bundle, lock, root / 'installed')

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
