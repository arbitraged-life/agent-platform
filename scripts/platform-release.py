#!/usr/bin/env python3
"""Build reproducible release bundles and install digest-pinned local bundles."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import secrets
import shutil
import stat
# qlty-ignore(bandit:B404): Required CLI execution uses argv arrays without a shell.
import subprocess
import tarfile
import tempfile
import unicodedata


GIT_EXECUTABLE = shutil.which('git')


MANIFEST_NAME = 'release-manifest.json'
MAX_RELEASE_BYTES = 64 * 1024 * 1024

def sha(data):
    return hashlib.sha256(data).hexdigest()


def release_path(value):
    name = PurePosixPath(value)
    if not name.parts or name.is_absolute() or PureWindowsPath(value).drive or '..' in name.parts or '\\' in value or ':' in value:
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
            try:
                os.mkdir(component, 0o755, dir_fd=parent_fd)
            except FileExistsError:
                pass
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


def _open_install_destination(destination):
    """Open every path component without following links, creating missing dirs.

    The CLI passes a separately validated canonical absolute destination;
    source-level Python callers must enforce their own trust policy.
    """
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise RuntimeError('Safe installation requires no-follow POSIX directory APIs')
    path = Path(destination).absolute()
    if '..' in path.parts:
        raise ValueError('Unsafe release installation directory')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory_fd = os.open(os.path.sep, flags)
    try:
        for component in path.parts[1:]:
            try:
                os.mkdir(component, 0o700, dir_fd=directory_fd)
            except FileExistsError:
                pass
            next_fd = os.open(component, flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        return directory_fd
    except BaseException:
        os.close(directory_fd)
        raise



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


def cli_release_destination(destination_arg, pinned_bundle):
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
    return Path(candidate)


def require_posix_installation():
    if os.name != 'posix':
        raise RuntimeError('Release installation and permission verification require POSIX filesystems')


def install(bundle, lock, destination, *, destination_is_canonical=False):
    """Install atomically through pinned directory fds, never mutable pathnames.

    For CLI use, the trusted destination was already canonicalized and bounded
    relative to the independently pinned lock. A Python API caller may pass
    a filesystem alias but remains responsible for its destination trust.
    """
    require_posix_installation()
    validate_lock(lock)
    if bundle.name != lock['artifact']:
        raise ValueError('Release artifact filename mismatch')
    if bundle.stat().st_size > MAX_RELEASE_BYTES:
        raise ValueError('Release bundle exceeds size limit')
    data = bundle.read_bytes()
    if sha(data) != lock['sha256']:
        raise ValueError('Release digest mismatch')
    # Python calls can resolve common system aliases such as macOS /tmp.
    # CLI paths have already been validated; do not re-resolve them here.
    destination = Path(destination) if destination_is_canonical else Path(os.path.realpath(destination))
    directory_fd = _open_install_destination(destination)
    opened_destination = os.fstat(directory_fd)
    temporary_name = '.install-' + secrets.token_hex(12)
    temporary_fd, renamed = None, False
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        try:
            os.stat(lock['commit'], dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise ValueError('Immutable install already exists; choose it explicitly or inspect drift')
        os.mkdir(temporary_name, 0o700, dir_fd=directory_fd)
        temporary_fd = os.open(temporary_name, flags, dir_fd=directory_fd)
        _extract_bundle(data, temporary_fd)
        names, modes, sizes, manifest_bytes, declared = _expected_release_inventory(data, lock)
        expected_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents
                         if str(parent) != '.'}
        installed = _scan_installed_release(temporary_fd, expected_dirs, modes, sizes)
        if set(installed) != names or installed[MANIFEST_NAME] != sha(manifest_bytes):
            raise ValueError('Release manifest mismatch')
        if any(installed[name] != digest for name, digest in declared.items()):
            raise ValueError('Release manifest mismatch')
        staged = os.fstat(temporary_fd)
        named_stage = os.stat(temporary_name, dir_fd=directory_fd, follow_symlinks=False)
        if (not stat.S_ISDIR(named_stage.st_mode) or
                (staged.st_dev, staged.st_ino) != (named_stage.st_dev, named_stage.st_ino)):
            raise ValueError('Release staging directory changed during installation')
        os.rename(temporary_name, lock['commit'], src_dir_fd=directory_fd,
                  dst_dir_fd=directory_fd)
        renamed = True
        named_target = os.stat(lock['commit'], dir_fd=directory_fd, follow_symlinks=False)
        if (not stat.S_ISDIR(named_target.st_mode) or
                (staged.st_dev, staged.st_ino) !=
                (named_target.st_dev, named_target.st_ino)):
            raise ValueError('Release staging directory changed during installation')
        current_path = os.stat(destination, follow_symlinks=False)
        current_fd = os.fstat(directory_fd)
        if any((getattr(opened_destination, field) != getattr(current, field))
               for current in (current_path, current_fd) for field in ('st_dev', 'st_ino')):
            raise ValueError('Release destination changed during installation')
    finally:
        if temporary_fd is not None:
            if not renamed:
                # Only clean up our own staging inode. Never traverse or
                # remove an attacker-swapped entry on an exceptional path.
                try:
                    staged = os.fstat(temporary_fd)
                    named = os.stat(temporary_name, dir_fd=directory_fd,
                                    follow_symlinks=False)
                    if (stat.S_ISDIR(named.st_mode) and
                            (staged.st_dev, staged.st_ino) ==
                            (named.st_dev, named.st_ino)):
                        shutil.rmtree(temporary_name, dir_fd=directory_fd)
                except OSError:
                    pass
            os.close(temporary_fd)
        os.close(directory_fd)
    return destination / lock['commit']



def _inventory_installed_release(destination, commit, expected_dirs, expected_modes, expected_sizes):
    """Inventory through pinned directory inodes and reject path replacement."""
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise RuntimeError('Release verification requires no-follow POSIX directory APIs')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        destination_fd = os.open(destination, flags)
    except OSError as exc:
        raise ValueError('Verified installation directory is unavailable or unsafe') from exc
    try:
        try:
            release_fd = os.open(commit, flags, dir_fd=destination_fd)
        except OSError as exc:
            raise ValueError('Verified installation directory is unavailable or unsafe') from exc
        try:
            release_identity = os.fstat(release_fd)
            destination_identity = os.fstat(destination_fd)
            installed = _scan_installed_release(release_fd, expected_dirs, expected_modes, expected_sizes)
            current_release = os.stat(commit, dir_fd=destination_fd, follow_symlinks=False)
            current_destination = os.stat(destination, follow_symlinks=False)
            if (not stat.S_ISDIR(current_release.st_mode) or
                    (current_release.st_dev, current_release.st_ino) !=
                    (release_identity.st_dev, release_identity.st_ino) or
                    not stat.S_ISDIR(current_destination.st_mode) or
                    (current_destination.st_dev, current_destination.st_ino) !=
                    (destination_identity.st_dev, destination_identity.st_ino)):
                raise ValueError('Installed release directory changed during readback')
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


def _scan_installed_release(root_fd, expected_dirs, expected_modes, expected_sizes):
    """Hold parent dirfds until descendants and their directory entries are rechecked.

    This detects swaps during readback but is not an immutable filesystem
    snapshot; callers must prevent concurrent mutation for durable acceptance.
    """
    installed, seen, stack = {}, 0, []
    root_copy = os.dup(root_fd)
    try:
        stack.append(('', root_copy, None, None,
                      os.fstat(root_copy), iter(os.listdir(root_copy))))
        while stack:
            prefix, directory_fd, parent_fd, name, initial, entries = stack[-1]
            try:
                component = next(entries)
            except StopIteration:
                if not _unchanged_inode(initial, os.fstat(directory_fd)):
                    raise ValueError('Installed release directory changed during readback')
                if parent_fd is not None:
                    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
                    if not _unchanged_inode(initial, current):
                        raise ValueError('Installed release directory changed during readback')
                os.close(directory_fd)
                stack.pop()
                continue
            seen += 1
            if seen > 10000:
                raise ValueError('Too many installed release entries')
            relative = prefix + component
            child_fd, digest_value = _read_installed_entry(
                directory_fd, component, relative,
                expected_dirs, expected_modes, expected_sizes)
            if child_fd is not None:
                try:
                    stack.append((relative + '/', child_fd, directory_fd,
                                  component, os.fstat(child_fd), iter(os.listdir(child_fd))))
                except BaseException:
                    os.close(child_fd)
                    raise
            else:
                installed[relative] = digest_value
    except OSError as exc:
        raise ValueError('Installed release has an unsafe or changed path') from exc
    finally:
        for _, unused_fd, _, _, _, _ in stack:
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


def verify_installation(bundle, lock, destination):
    """Check installed bytes against the caller-supplied lock and artifact.

    This cannot authenticate a Python caller's choice of lock: the caller must
    separately trust the lock source. Passing does not establish deployment
    or runtime acceptance or that contents remain immutable after readback.
    """
    require_posix_installation()
    validate_lock(lock)
    if bundle.name != lock['artifact'] or bundle.stat().st_size > MAX_RELEASE_BYTES:
        raise ValueError('Release artifact name/size mismatch')
    data = bundle.read_bytes()
    if sha(data) != lock['sha256']:
        raise ValueError('Release digest mismatch')
    names, expected_modes, expected_sizes, manifest_bytes, declared = _expected_release_inventory(data, lock)

    target = destination / lock['commit']
    expected_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents
                     if str(parent) != '.'}
    installed = _inventory_installed_release(
        destination, lock['commit'], expected_dirs, expected_modes, expected_sizes)
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
        destination = cli_release_destination(args.destination, pinned_bundle)
        if args.command == 'install':
            print(install(pinned_bundle, pinned_lock, destination, destination_is_canonical=True))
        else:
            print(json.dumps(verify_installation(pinned_bundle, pinned_lock, destination), indent=2))


if __name__ == '__main__':
    main()
