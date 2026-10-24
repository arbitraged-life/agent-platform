#!/usr/bin/env python3
"""Build reproducible release bundles and install digest-pinned local bundles."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
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



def _extract_bundle(data, temporary):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        total = 0
        members = archive.getmembers()
        if len(members) > 10000:
            raise ValueError('Too many release entries')
        seen = set()
        spellings = {}
        for member in members:
            name = register_path(member.name, spellings)
            if not member.isfile() or str(name) in seen:
                raise ValueError('Unsafe release entry')
            seen.add(str(name))
            total += member.size
            if total > MAX_RELEASE_BYTES:
                raise ValueError('Expanded release exceeds size limit')
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as stream:
                path.write_bytes(stream.read())
            path.chmod(0o755 if member.mode & 0o111 else 0o644)


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


def install(bundle, lock, destination):
    require_posix_installation()
    validate_lock(lock)
    if bundle.stat().st_size > MAX_RELEASE_BYTES:
        raise ValueError('Release bundle exceeds size limit')
    data = bundle.read_bytes()
    if sha(data) != lock['sha256']:
        raise ValueError('Release digest mismatch')
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / lock['commit']
    if target.exists():
        raise ValueError('Immutable install already exists; choose it explicitly or inspect drift')
    temporary = Path(tempfile.mkdtemp(prefix='.install-', dir=destination))
    renamed = False
    try:
        _extract_bundle(data, temporary)
        manifest = json.loads((temporary / MANIFEST_NAME).read_text())
        if type(manifest.get('schema_version')) is not int or manifest['schema_version'] != 1 or manifest.get('commit') != lock['commit']:
            raise ValueError('Release manifest identity mismatch')
        actual = {str(p.relative_to(temporary)): sha(p.read_bytes()) for p in temporary.rglob('*') if p.is_file() and p != temporary / MANIFEST_NAME}
        if actual != manifest.get('files'):
            raise ValueError('Release content manifest mismatch')
        os.rename(temporary, target)
        renamed = True
    finally:
        # Never remove a renamed installation, including if a temporary-path
        # collision is observed after successful publication.
        if not renamed and temporary.exists():
            shutil.rmtree(temporary)
    return target


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


def _read_installed_file(directory_fd, component, expected_mode, expected_size):
    """Read only an opened regular inode from its verified parent dirfd."""
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW
    file_fd = os.open(component, flags, dir_fd=directory_fd)
    with os.fdopen(file_fd, 'rb') as stream:
        current = os.fstat(stream.fileno())
        if not stat.S_ISREG(current.st_mode):
            raise ValueError('Installed release has a special file')
        if current.st_size != expected_size:
            raise ValueError('Installed release size mismatch')
        if stat.S_IMODE(current.st_mode) != expected_mode:
            raise ValueError('Installed release permission mismatch')
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _read_installed_entry(directory_fd, component, relative, expected_dirs, modes, sizes):
    """Return either an anchored child-directory fd or a checked file digest."""
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
    """Enumerate and hash installed regular files using dirfd-relative opens."""
    installed, stack, seen = {}, [('', os.dup(root_fd))], 0
    try:
        while stack:
            prefix, directory_fd = stack.pop()
            try:
                for component in os.listdir(directory_fd):
                    seen += 1
                    if seen > 10000:
                        raise ValueError('Too many installed release entries')
                    relative = prefix + component
                    child_fd, digest_value = _read_installed_entry(
                        directory_fd, component, relative,
                        expected_dirs, expected_modes, expected_sizes)
                    if child_fd is not None:
                        stack.append((relative + '/', child_fd))
                    else:
                        installed[relative] = digest_value
            finally:
                os.close(directory_fd)
    except OSError as exc:
        raise ValueError('Installed release has an unsafe or changed path') from exc
    finally:
        for _, unused_fd in stack:
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
            raise ValueError('Release manifest content mismatch')
    return manifest_bytes, declared


def _expected_release_inventory(data, lock):
    """Check the archive digest's manifest and return its byte/mode inventory."""
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        members, names, modes, file_sizes = _checked_release_members(archive)
        manifest_bytes, declared = _checked_release_manifest(archive, lock, members, names)
    return names, modes, file_sizes, manifest_bytes, declared


def verify_installation(bundle, lock, destination):
    """Independently compare trusted release lock, artifact and installed bytes.

    Read-only acceptance evidence. Passing does NOT prove that an installed
    release is selected, deployed, executing, or permitted to act.
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
            print(install(pinned_bundle, pinned_lock, destination))
        else:
            print(json.dumps(verify_installation(pinned_bundle, pinned_lock, destination), indent=2))


if __name__ == '__main__':
    main()
