#!/usr/bin/env python3
"""Build reproducible release bundles and install digest-pinned local bundles."""
import argparse
import ctypes
import errno
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets
import shutil
import stat
import sys
# qlty-ignore(bandit:B404): Required CLI execution uses argv arrays without a shell.
import subprocess
import tarfile
import tempfile
import unicodedata


GIT_EXECUTABLE = shutil.which('git')


MANIFEST_NAME = 'release-manifest.json'
MAX_RELEASE_BYTES = 64 * 1024 * 1024
MAX_RELEASE_DEPTH = 32  # Limit retained directory descriptors during verification.
INSTALL_DIRECTORY_MODES = {0o700, 0o750, 0o755}  # No group/world-write modes.
READBACK_DIRECTORY_CHANGED = 'Installed release directory changed during readback'

def sha(data):
    return hashlib.sha256(data).hexdigest()


def release_path(value):
    name = PurePosixPath(value)
    if (not name.parts or len(name.parts) > MAX_RELEASE_DEPTH or name.is_absolute() or
            PureWindowsPath(value).drive or '..' in name.parts or '\\' in value or ':' in value):
        raise ValueError('Unsafe release entry')
    reserved = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'}
    reserved.update(prefix + digit for prefix in ('COM', 'LPT') for digit in '123456789¹²³')
    for part in name.parts:
        if (part.endswith(('.', ' ')) or part.split('.')[0].rstrip(' ').upper() in reserved
                or any(ord(char) < 32 or char in '<>"|?*' for char in part)):
            raise ValueError('Unsafe release entry')
    return name


def register_path(value, spellings):
    name = release_path(value)
    if len(name.parts) > 1 and name.parts[0].casefold() == MANIFEST_NAME.casefold():
        raise ValueError('Unsafe release path alias')
    for count in range(1, len(name.parts) + 1):
        spelling = '/'.join(name.parts[:count])
        key = unicodedata.normalize('NFC', spelling).casefold()
        previous = spellings.setdefault(key, spelling)
        if previous != spelling:
            raise ValueError('Unsafe release path alias')
    return name


def build(root, output):
    if GIT_EXECUTABLE is None:
        raise RuntimeError('git executable is required to build a release')
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    if subprocess.check_output([GIT_EXECUTABLE, '-C', str(root), 'status', '--porcelain'], text=True).strip():
        raise ValueError('Release build requires a clean working tree')
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    commit = subprocess.check_output([GIT_EXECUTABLE, '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    files, modes = {}, {}
    spellings = {}
    register_path(MANIFEST_NAME, spellings)
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    process = subprocess.Popen([GIT_EXECUTABLE, '-c', 'tar.umask=0000', '-C', str(root), 'archive', '--format=tar', commit], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    total = 0
    entries = 0
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as source:
            for member in source:
                entries += 1
                total += member.size
                if entries > 10000 or total > MAX_RELEASE_BYTES:
                    raise ValueError('Expanded release exceeds size limit')
                if member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError(f'Unsupported release entry: {member.name}')
                register_path(member.name, spellings)
                if member.name == MANIFEST_NAME:
                    raise ValueError('Reserved release manifest in source')
                files[member.name] = source.extractfile(member).read()
                modes[member.name] = 0o755 if member.mode & 0o111 else 0o644
        if process.wait(timeout=30) != 0:
            raise RuntimeError('Git archive failed')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
        process.wait()
    manifest = {'schema_version': 1, 'commit': commit, 'files': {name: sha(data) for name, data in files.items()}}
    files[MANIFEST_NAME] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode()
    if len(files)>10000 or sum(map(len,files.values()))>MAX_RELEASE_BYTES:
        raise ValueError('Expanded release exceeds size limit')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix='.release-', dir=output.parent, delete=False) as created:
        temporary = Path(created.name)
    try:
        with tarfile.open(temporary, 'w') as archive:
            for name, data in sorted(files.items()):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                info.mode = modes.get(name, 0o644)
                info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
        if temporary.stat().st_size > MAX_RELEASE_BYTES:
            raise ValueError('Release bundle exceeds size limit')
        digest = sha(temporary.read_bytes())
        temporary.chmod(0o644)
        os.replace(temporary, output)
        return {'schema_version': 1, 'commit': commit, 'sha256': digest, 'artifact': output.name}
    finally:
        temporary.unlink(missing_ok=True)



def _write_release_member(root_fd, archive, member):
    """Create release entries only through no-follow directory descriptors."""
    components = PurePosixPath(member.name).parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent_fd = os.dup(root_fd)
    try:
        for component in components[:-1]:
            # The staging root remains private. Nested release directories
            # use canonical permissions regardless of the caller's umask.
            _create_install_component(parent_fd, component, 0o755)
            child_fd = os.open(component, flags, dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = child_fd
        file_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        file_fd = os.open(components[-1], file_flags, 0o600, dir_fd=parent_fd)
        with os.fdopen(file_fd, 'wb') as target, archive.extractfile(member) as stream:
            shutil.copyfileobj(stream, target, length=1024 * 1024)
            target.flush()
            os.fchmod(target.fileno(), 0o755 if member.mode & 0o111 else 0o644)
    finally:
        os.close(parent_fd)


def _extract_bundle(data, temporary_fd):
    """Extract untrusted archive bytes to a pinned private directory inode."""
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) > 10000:
            raise ValueError('Too many release entries')
        seen, spellings, total = set(), {}, 0
        for member in members:
            name = register_path(member.name, spellings)
            if not member.isfile() or str(name) in seen:
                raise ValueError('Unsafe release entry')
            seen.add(str(name))
            total += member.size
            if total > MAX_RELEASE_BYTES:
                raise ValueError('Expanded release exceeds size limit')
            _write_release_member(temporary_fd, archive, member)


def _create_install_component(parent_fd, component, directory_mode):
    try:
        os.mkdir(component, directory_mode, dir_fd=parent_fd)
    except FileExistsError:
        return
    # Restore the selected mode even when an inherited umask is 0777.
    # chmod with dir_fd and nofollow needs no read access on the new inode.
    # The trusted parent must be protected from independently privileged writers.
    created = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISDIR(created.st_mode):
        raise ValueError('New release installation entry is not a directory')
    os.chmod(component, directory_mode, dir_fd=parent_fd,
             follow_symlinks=False)
    current = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    if ((created.st_dev, created.st_ino) != (current.st_dev, current.st_ino) or
            stat.S_IMODE(current.st_mode) != directory_mode):
        raise ValueError('New release installation directory changed during mode normalization')


def _open_install_destination(destination, *, create=True, directory_mode=0o700):
    """Open every path component without following links, creating missing dirs.

    The CLI passes a separately validated canonical absolute destination;
    source-level Python callers must enforce their own trust policy.
    """
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise RuntimeError('Safe installation requires no-follow POSIX directory APIs')
    if type(directory_mode) is not int or directory_mode not in INSTALL_DIRECTORY_MODES:
        raise ValueError('Unsupported release directory mode')
    path = Path(destination).absolute()
    if '..' in path.parts:
        raise ValueError('Unsafe release installation directory')
    # Linux O_PATH allows safe traversal through search-only ancestors.
    # Other POSIX systems use O_SEARCH where exposed, otherwise O_RDONLY.
    access_flag = getattr(os, 'O_PATH', None)
    if access_flag is None:
        # CPython 3.11 does not expose Darwin O_SEARCH, although macOS
        # defines it as O_EXEC | O_DIRECTORY in <sys/fcntl.h>.
        access_flag = (getattr(os, 'O_SEARCH', 0x40000000 | os.O_DIRECTORY)
                       if sys.platform == 'darwin' else getattr(os, 'O_SEARCH', os.O_RDONLY))
    flags = access_flag | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_fd = os.open(os.path.sep, flags)
    try:
        for component in path.parts[1:]:
            if create:
                _create_install_component(directory_fd, component, directory_mode)
            next_fd = os.open(component, flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        # Release roots must not admit unrelated local writers. POSIX sticky
        # ancestors (e.g. /tmp) are allowed; the selected root itself is not.
        mode = os.fstat(directory_fd).st_mode
        if mode & (stat.S_IWGRP | stat.S_IWOTH):
            raise ValueError('Unsafe writable release installation directory')
        return directory_fd
    except BaseException:
        os.close(directory_fd)
        raise


def _assert_destination_unchanged(destination, expected_fd, *, phase='installation'):
    """Rewalk every ancestor without following links; compare the actual inode."""
    current_fd = _open_install_destination(destination, create=False)
    try:
        expected, current = os.fstat(expected_fd), os.fstat(current_fd)
        if (expected.st_dev, expected.st_ino) != (current.st_dev, current.st_ino):
            raise ValueError(f'Release destination changed during {phase}')
    except OSError as exc:
        raise ValueError(f'Release destination changed during {phase}') from exc
    finally:
        os.close(current_fd)


def _rename_no_replace(stage, target, directory_fd):
    """Atomic exclusive publication on supported macOS and Linux filesystems.

    Never fall back to os.rename: it can overwrite an existing release.
    """
    if sys.platform == 'darwin':
        symbol, flags = 'renameatx_np', 0x4  # <sys/stdio.h> RENAME_EXCL
    elif sys.platform.startswith('linux'):
        symbol, flags = 'renameat2', 0x1  # linux/fs.h RENAME_NOREPLACE
    else:
        raise RuntimeError('Atomic no-replace release publication is unsupported')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, symbol, None)
    if rename is None:
        raise RuntimeError('Atomic no-replace release publication is unavailable')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(directory_fd, os.fsencode(stage), directory_fd, os.fsencode(target), flags) != 0:
        code = ctypes.get_errno()
        if code in (errno.ENOTSUP, errno.ENOSYS, errno.EOPNOTSUPP):
            raise RuntimeError('Filesystem does not support atomic no-replace publication')
        raise OSError(code, os.strerror(code), target)


def validate_lock(lock):
    if not isinstance(lock, dict) or set(lock) != {'schema_version', 'commit', 'sha256', 'artifact'} or type(lock.get('schema_version')) is not int or lock['schema_version'] != 1:
        raise ValueError('Unsupported release lock')
    if not isinstance(lock['commit'], str) or not re.fullmatch('[0-9a-f]{40}', lock['commit']) or not isinstance(lock['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', lock['sha256']):
        raise ValueError('Invalid release identity')
    if (not isinstance(lock['artifact'], str) or not lock['artifact'] or
            lock['artifact'] in {'.', '..'} or lock['artifact'] != Path(lock['artifact']).name or
            PureWindowsPath(lock['artifact']).name != lock['artifact']):
        raise ValueError('Invalid release artifact name')


def cli_bundle_and_lock(bundle_arg, lock_arg, expected_lock_sha256):
    """Verify a separately pinned lock digest before accepting CLI artifact bytes.

    The caller must obtain the expected digest from an independently trusted
    source. Colocation alone cannot authenticate an attacker-supplied lock;
    resolving symlinked parent aliases is safe only with this content pin.
    Direct Python callers must enforce an equivalent trusted lock boundary.
    """
    if not isinstance(expected_lock_sha256, str) or not re.fullmatch('[0-9a-f]{64}', expected_lock_sha256):
        raise ValueError('Missing or invalid independently pinned release lock SHA-256')
    if (bundle_arg.is_symlink() or lock_arg.is_symlink() or
            '..' in bundle_arg.parts or '..' in lock_arg.parts):
        raise ValueError('Unsafe release argument path')
    if bundle_arg.parent.absolute() != lock_arg.parent.absolute():
        raise ValueError('Release bundle and lock must use the same explicit directory')
    trusted_lock = lock_arg.resolve(strict=True)
    trusted_dir = trusted_lock.parent
    with trusted_lock.open('rb') as stream:
        lock_bytes = stream.read(65537)
    if len(lock_bytes) > 65536 or sha(lock_bytes) != expected_lock_sha256:
        raise ValueError('Untrusted release lock: digest or size mismatch')
    lock = json.loads(lock_bytes)
    validate_lock(lock)
    expected = trusted_dir / lock['artifact']
    supplied = bundle_arg.resolve(strict=True)
    if not supplied.is_relative_to(trusted_dir) or supplied != expected:
        raise ValueError('Release bundle must share the trusted lock directory and exact artifact name')
    if not supplied.is_file() or supplied.is_symlink():
        raise ValueError('Unsafe release bundle file')
    return expected, lock


def cli_release_destination(destination_arg, pinned_bundle, *, pin_for_install=False, directory_mode=0o700, create=True):
    """Constrain agent-supplied destination paths to a pinned release directory.

    The artifact and lock have already passed independent digest validation.
    Resolve parent symlinks and reject any location outside that trusted directory.
    Direct Python callers must enforce their own installation-directory policy.
    """
    if '..' in destination_arg.parts:
        raise ValueError('Unsafe release destination path traversal')
    base = os.path.realpath(pinned_bundle.parent)
    candidate = os.path.realpath(destination_arg)
    if base == os.path.sep or not candidate.startswith(base + os.sep):
        raise ValueError('Release destination must be inside trusted artifact directory')
    destination = Path(candidate)
    if not pin_for_install:
        return destination
    # Capture the validated inode *before* handing control to install().
    # Never re-open by pathname after an asynchronous agent or hook runs.
    fd = _open_install_destination(destination, create=create, directory_mode=directory_mode)
    try:
        if os.path.realpath(destination_arg) != candidate:
            raise ValueError('Release destination changed during validation')
        _assert_destination_unchanged(destination, fd)
        return destination, fd
    except BaseException:
        os.close(fd)
        raise


def require_posix_installation():
    if os.name != 'posix':
        raise RuntimeError('Release installation and permission verification require POSIX filesystems')


def _read_pinned_bundle(bundle, lock):
    validate_lock(lock)
    if bundle.name != lock['artifact']:
        raise ValueError('Release artifact filename mismatch')
    # A separate stat followed by read_bytes is vulnerable to concurrent
    # growth; a bounded read cannot allocate beyond the release size cap.
    with bundle.open('rb') as stream:
        data = stream.read(MAX_RELEASE_BYTES + 1)
    if len(data) > MAX_RELEASE_BYTES:
        raise ValueError('Release bundle exceeds size limit')
    if sha(data) != lock['sha256']:
        raise ValueError('Release digest mismatch')
    return data


def _check_staged_release(data, lock, temporary_fd):
    names, modes, sizes, manifest_bytes, declared = _expected_release_inventory(data, lock)
    expected_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents
                     if str(parent) != '.'}
    installed = _scan_installed_release(temporary_fd, expected_dirs, modes, sizes)
    if set(installed) != names or installed[MANIFEST_NAME] != sha(manifest_bytes):
        raise ValueError('Release manifest mismatch')
    if any(installed[name] != digest for name, digest in declared.items()):
        raise ValueError('Release manifest mismatch')


def _publish_staged_release(destination, directory_fd, temporary_fd, temporary_name, commit, directory_mode):
    staged = os.fstat(temporary_fd)
    named_stage = os.stat(temporary_name, dir_fd=directory_fd, follow_symlinks=False)
    if (not stat.S_ISDIR(named_stage.st_mode) or
            (staged.st_dev, staged.st_ino) !=
            (named_stage.st_dev, named_stage.st_ino)):
        raise ValueError('Release staging directory changed during installation')
    _assert_destination_unchanged(destination, directory_fd)
    # Keep staging private through archive validation; apply the explicit
    # consumer directory mode only immediately before atomic publication.
    os.fchmod(temporary_fd, directory_mode)
    _rename_no_replace(temporary_name, commit, directory_fd)
    named_target = os.stat(commit, dir_fd=directory_fd, follow_symlinks=False)
    if (not stat.S_ISDIR(named_target.st_mode) or
            (staged.st_dev, staged.st_ino) !=
            (named_target.st_dev, named_target.st_ino)):
        raise ValueError('Release staging directory changed during installation')
    _assert_destination_unchanged(destination, directory_fd)


def _cleanup_owned_stage(temporary_fd, temporary_name, directory_fd):
    """Attempt deletion only when the stage name still refers to our inode."""
    if temporary_fd is None:
        return None
    try:
        staged = os.fstat(temporary_fd)
        named = os.stat(temporary_name, dir_fd=directory_fd, follow_symlinks=False)
        if (stat.S_ISDIR(named.st_mode) and
                (staged.st_dev, staged.st_ino) == (named.st_dev, named.st_ino)):
            shutil.rmtree(temporary_name, dir_fd=directory_fd)
    except FileNotFoundError:
        pass
    except OSError as exc:
        return exc
    return None


def install(bundle, lock, destination, *, destination_is_canonical=False, destination_fd=None, directory_mode=0o700):
    """Install through trusted directory fds with atomic no-replace publication.

    CLI callers supply a prevalidated and pinned destination descriptor.
    Python API callers enforce their own trusted destination/lock provenance.
    """
    require_posix_installation()
    data = _read_pinned_bundle(bundle, lock)
    # Python callers may use macOS system aliases, e.g. /tmp -> /private/tmp.
    destination = Path(destination) if destination_is_canonical else Path(os.path.realpath(destination))
    directory_fd = (os.dup(destination_fd) if destination_fd is not None
                    else _open_install_destination(destination, directory_mode=directory_mode))
    temporary_name = '.install-' + secrets.token_hex(12)
    temporary_fd = None
    try:
        _assert_destination_unchanged(destination, directory_fd)
        try:
            os.stat(lock['commit'], dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('Immutable install already exists; choose it explicitly or inspect drift')
        os.mkdir(temporary_name, 0o700, dir_fd=directory_fd)
        # A caller can inherit an umask of 0777; recover private access by
        # dirfd-relative no-follow chmod without exposing staged data.
        os.chmod(temporary_name, 0o700, dir_fd=directory_fd,
                 follow_symlinks=False)
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        temporary_fd = os.open(temporary_name, flags, dir_fd=directory_fd)
        _extract_bundle(data, temporary_fd)
        _check_staged_release(data, lock, temporary_fd)
        _publish_staged_release(destination, directory_fd, temporary_fd,
                                temporary_name, lock['commit'], directory_mode)
    finally:
        original_error = sys.exception()
        try:
            cleanup_failure = _cleanup_owned_stage(
                temporary_fd, temporary_name, directory_fd)
        finally:
            if temporary_fd is not None:
                os.close(temporary_fd)
            os.close(directory_fd)
        if cleanup_failure is not None:
            message = (f'Release staging cleanup failed for {temporary_name}; '
                       'manual inspection required')
            if original_error is not None:
                original_error.add_note(message)
            else:
                raise RuntimeError(message) from cleanup_failure
    return destination / lock['commit']



def _inventory_installed_release(destination, commit, expected_dirs, expected_modes, expected_sizes, *, destination_fd=None):
    """Inventory through pinned directory inodes and reject path replacement."""
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise RuntimeError('Release verification requires no-follow POSIX directory APIs')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        destination_fd = (os.dup(destination_fd) if destination_fd is not None
                          else _open_install_destination(destination, create=False))
    except OSError as exc:
        raise ValueError('Verified installation directory is unavailable or unsafe') from exc
    try:
        try:
            release_fd = os.open(commit, flags, dir_fd=destination_fd)
        except OSError as exc:
            raise ValueError('Verified installation directory is unavailable or unsafe') from exc
        try:
            release_identity = os.fstat(release_fd)
            installed = _scan_installed_release(release_fd, expected_dirs, expected_modes, expected_sizes)
            current_release = os.stat(commit, dir_fd=destination_fd, follow_symlinks=False)
            if (not stat.S_ISDIR(current_release.st_mode) or
                    (current_release.st_dev, current_release.st_ino) !=
                    (release_identity.st_dev, release_identity.st_ino)):
                raise ValueError(READBACK_DIRECTORY_CHANGED)
            _assert_destination_unchanged(destination, destination_fd, phase='readback')
            return installed
        except OSError as exc:
            raise ValueError('Installed release has an unsafe or changed path') from exc
        finally:
            os.close(release_fd)
    finally:
        os.close(destination_fd)


def _unchanged_inode(before, after):
    # Directory-entry and content mutations also change ctime.
    return all(getattr(before, key) == getattr(after, key) for key in (
        'st_dev', 'st_ino', 'st_mode', 'st_size', 'st_mtime_ns', 'st_ctime_ns'))


def _read_installed_file(directory_fd, component, expected_mode, expected_size):
    """Hash at most the trusted size; verify the inode remains installed."""
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    file_fd = os.open(component, flags, dir_fd=directory_fd)
    with os.fdopen(file_fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise ValueError('Installed release has a special file')
        if before.st_size != expected_size:
            raise ValueError('Installed release size mismatch')
        if stat.S_IMODE(before.st_mode) != expected_mode:
            raise ValueError('Installed release permission mismatch')
        digest = hashlib.sha256()
        remaining = expected_size
        while remaining:
            chunk = stream.read(min(1024 * 1024, remaining))
            if not chunk:
                raise ValueError('Installed release size changed during readback')
            digest.update(chunk)
            remaining -= len(chunk)
        if stream.read(1):
            raise ValueError('Installed release size changed during readback')
        named = os.stat(component, dir_fd=directory_fd, follow_symlinks=False)
        if (not _unchanged_inode(before, os.fstat(stream.fileno()))
                or not _unchanged_inode(before, named)):
            raise ValueError('Installed release file changed during readback')
        return digest.hexdigest()


def _read_installed_entry(directory_fd, component, relative, expected_dirs, modes, sizes):
    """Return either a safely opened directory fd or a checked file digest."""
    current = os.stat(component, dir_fd=directory_fd, follow_symlinks=False)
    if stat.S_ISLNK(current.st_mode):
        raise ValueError('Installed release has a symbolic link')
    if stat.S_ISDIR(current.st_mode):
        if relative not in expected_dirs:
            raise ValueError('Installed release file inventory mismatch')
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        return os.open(component, flags, dir_fd=directory_fd), None
    if not stat.S_ISREG(current.st_mode):
        raise ValueError('Installed release has a special file')
    if relative not in modes:
        raise ValueError('Installed release file inventory mismatch')
    return None, _read_installed_file(directory_fd, component,
                                      modes[relative], sizes[relative])


def _finish_installed_directory(frame):
    _, directory_fd, parent_fd, name, initial, entries = frame
    if not _unchanged_inode(initial, os.fstat(directory_fd)):
        raise ValueError(READBACK_DIRECTORY_CHANGED)
    if parent_fd is not None:
        current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        if not _unchanged_inode(initial, current):
            raise ValueError(READBACK_DIRECTORY_CHANGED)
    entries.close()
    os.close(directory_fd)


def _scan_installed_release(root_fd, expected_dirs, expected_modes, expected_sizes):
    """Hold parent dirfds until descendants and their directory entries are rechecked.

    This detects swaps during readback but is not an immutable filesystem
    snapshot; callers must prevent concurrent mutation for durable acceptance.
    """
    installed, seen, stack = {}, 0, []
    root_copy = os.dup(root_fd)
    try:
        root_entries = os.scandir(root_copy)
    except BaseException:
        os.close(root_copy)
        raise
    stack.append(('', root_copy, None, None, os.fstat(root_copy), root_entries))
    try:
        while stack:
            prefix, directory_fd, _, _, _, entries = stack[-1]
            try:
                component = next(entries).name
            except StopIteration:
                _finish_installed_directory(stack[-1])
                stack.pop()
                continue
            seen += 1
            # Archive count excludes the implicit parent directories.
            if seen > len(expected_modes) + len(expected_dirs):
                raise ValueError('Too many installed release entries (inventory mismatch)')
            relative = prefix + component
            child_fd, digest_value = _read_installed_entry(
                directory_fd, component, relative,
                expected_dirs, expected_modes, expected_sizes)
            if child_fd is not None:
                try:
                    stack.append((relative + '/', child_fd, directory_fd,
                                  component, os.fstat(child_fd), os.scandir(child_fd)))
                except BaseException:
                    os.close(child_fd)
                    raise
            else:
                installed[relative] = digest_value
    except OSError as exc:
        raise ValueError('Installed release has an unsafe or changed path') from exc
    finally:
        for _, unused_fd, _, _, _, entries in stack:
            entries.close()
            os.close(unused_fd)
    return installed

def _checked_release_members(archive):
    spellings = {}
    members = archive.getmembers()
    if len(members) > 10000:
        raise ValueError('Too many release entries')
    names, sizes = set(), 0
    for member in members:
        register_path(member.name, spellings)
        if not member.isfile() or member.name in names:
            raise ValueError('Unsupported release entry')
        names.add(member.name)
        sizes += member.size
        if sizes > MAX_RELEASE_BYTES:
            raise ValueError('Expanded release exceeds size limit')
    if MANIFEST_NAME not in names:
        raise ValueError('Missing release manifest')
    modes = {m.name: (0o755 if m.mode & 0o111 else 0o644) for m in members}
    file_sizes = {m.name: m.size for m in members}
    return members, names, modes, file_sizes


def _checked_release_manifest(archive, lock, members, names):
    manifest_bytes = archive.extractfile(MANIFEST_NAME).read()
    manifest = json.loads(manifest_bytes)
    if type(manifest.get('schema_version')) is not int or manifest['schema_version'] != 1 or manifest.get('commit') != lock['commit']:
        raise ValueError('Release manifest identity mismatch')
    declared = manifest.get('files')
    if not isinstance(declared, dict) or set(declared) | {MANIFEST_NAME} != names:
        raise ValueError('Release manifest file list mismatch')
    for member in members:
        if member.name != MANIFEST_NAME and sha(archive.extractfile(member).read()) != declared.get(member.name):
            raise ValueError('Release content manifest mismatch')
    return manifest_bytes, declared


def _expected_release_inventory(data, lock):
    """Check the archive digest's manifest and return its byte/mode inventory."""
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        members, names, modes, file_sizes = _checked_release_members(archive)
        manifest_bytes, declared = _checked_release_manifest(archive, lock, members, names)
    return names, modes, file_sizes, manifest_bytes, declared


def verify_installation(bundle, lock, destination, *, destination_fd=None):
    """Check installed bytes against the caller-supplied lock and artifact.

    This cannot authenticate a Python caller's choice of lock: the caller must
    separately trust the lock source. Passing does not establish deployment
    or runtime acceptance or that contents remain immutable after readback.
    """
    require_posix_installation()
    data = _read_pinned_bundle(bundle, lock)
    destination = (Path(destination) if destination_fd is not None
                   else Path(os.path.realpath(destination)))
    names, expected_modes, expected_sizes, manifest_bytes, declared = _expected_release_inventory(data, lock)

    target = destination / lock['commit']
    expected_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents
                     if str(parent) != '.'}
    installed = _inventory_installed_release(
        destination, lock['commit'], expected_dirs, expected_modes, expected_sizes,
        destination_fd=destination_fd)
    if set(installed) != names or installed[MANIFEST_NAME] != sha(manifest_bytes):
        raise ValueError('Installed release file inventory/manifest mismatch')
    if any(installed[name] != expected for name, expected in declared.items()):
        raise ValueError('Installed release content mismatch')
    return {
        'schema_version': 1,
        'status': 'installed-bytes-verified',
        'source_commit': lock['commit'],
        'release_sha256': lock['sha256'],
        'installed_path': str(target.absolute()),
        'verified_files': len(declared),
        'lock_origin_authenticated': None,
        'runtime_deployed': None,
        'runtime_accepted': None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    builder = sub.add_parser('build')
    builder.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    builder.add_argument('--output', type=Path, required=True)
    installer = sub.add_parser('install')
    installer.add_argument('--bundle', type=Path, required=True)
    installer.add_argument('--lock', type=Path, required=True)
    installer.add_argument('--expected-lock-sha256', required=True)
    installer.add_argument('--destination', type=Path, required=True)
    installer.add_argument('--directory-mode', type=lambda raw: int(raw, 8),
                           default=0o700, help='Mode for NEW install directories: 0700, 0750, 0755')
    verifier = sub.add_parser('verify')
    verifier.add_argument('--bundle', type=Path, required=True)
    verifier.add_argument('--lock', type=Path, required=True)
    verifier.add_argument('--expected-lock-sha256', required=True)
    verifier.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'build':
        print(json.dumps(build(args.root, args.output), indent=2))
    elif args.command in {'install', 'verify'}:
        pinned_bundle, pinned_lock = cli_bundle_and_lock(args.bundle, args.lock, args.expected_lock_sha256)
        directory_mode = args.directory_mode if args.command == 'install' else 0o700
        destination, fd = cli_release_destination(
            args.destination, pinned_bundle, pin_for_install=True,
            directory_mode=directory_mode, create=args.command == 'install')
        try:
            if args.command == 'install':
                print(install(pinned_bundle, pinned_lock, destination,
                              destination_is_canonical=True, destination_fd=fd,
                              directory_mode=directory_mode))
            else:
                print(json.dumps(verify_installation(
                    pinned_bundle, pinned_lock, destination, destination_fd=fd), indent=2))
        finally:
            os.close(fd)


if __name__ == '__main__':
    main()
