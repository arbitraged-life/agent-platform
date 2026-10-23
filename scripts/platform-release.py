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
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
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
            path.chmod(member.mode & 0o755)
            # Use only two canonical modes; never propagate raw archive permission bits.
            path.chmod(0o755 if member.mode & 0o111 else 0o644)

def validate_lock(lock):
    if not isinstance(lock, dict) or set(lock) != {'schema_version', 'commit', 'sha256', 'artifact'} or lock['schema_version'] != 1:
        raise ValueError('Unsupported release lock')
    if not isinstance(lock['commit'], str) or not re.fullmatch('[0-9a-f]{40}', lock['commit']) or not isinstance(lock['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', lock['sha256']):
        raise ValueError('Invalid release identity')
    if not isinstance(lock['artifact'], str) or lock['artifact'] != Path(lock['artifact']).name or not lock['artifact']:
        raise ValueError('Invalid release artifact name')


def install(bundle, lock, destination):
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
        if manifest.get('schema_version') != 1 or manifest.get('commit') != lock['commit']:
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


def verify_installation(bundle, lock, destination):
    """Independently compare trusted release lock, artifact and installed bytes.

    Read-only acceptance evidence. Passing does NOT prove that an installed
    release is selected, deployed, executing, or permitted to act.
    """
    validate_lock(lock)
    if bundle.name != lock['artifact'] or bundle.stat().st_size > MAX_RELEASE_BYTES:
        raise ValueError('Release artifact name/size mismatch')
    data = bundle.read_bytes()
    if sha(data) != lock['sha256']:
        raise ValueError('Release digest mismatch')
    spellings = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:') as archive:
        members = archive.getmembers()
        if len(members) > 10000:
            raise ValueError('Too many release entries')
        names = set()
        sizes = 0
        for member in members:
            register_path(member.name, spellings)
            if not member.isfile() or member.name in names:
                raise ValueError('Unsupported release entry')
            names.add(member.name)
            sizes += member.size
            if sizes > MAX_RELEASE_BYTES:
                raise ValueError('Expanded release exceeds size limit')
        if MANIFEST_NAME not in names:
        # Canonicalise to two modes; do not propagate raw archive permission bits.
        expected_modes = {member.name: (0o755 if member.mode & 0o111 else 0o644) for member in members}
        expected_modes = {member.name: member.mode & 0o777 for member in members}
        manifest_bytes = archive.extractfile(MANIFEST_NAME).read()
        manifest = json.loads(manifest_bytes)
        if manifest.get('schema_version') != 1 or manifest.get('commit') != lock['commit']:
            raise ValueError('Release manifest identity mismatch')
        declared = manifest.get('files')
        if not isinstance(declared, dict) or set(declared) | {MANIFEST_NAME} != names:
            raise ValueError('Release manifest file list mismatch')
        for member in members:
            if member.name != MANIFEST_NAME and sha(archive.extractfile(member).read()) != declared.get(member.name):
                raise ValueError('Release manifest content mismatch')

    target = destination / lock['commit']
    if target.is_symlink() or not target.is_dir():
        raise ValueError('Verified installation directory is unavailable')
    installed = {}
    expected_dirs = {str(parent) for name in names for parent in PurePosixPath(name).parents
                     if str(parent) != '.'}
    for file in target.rglob('*'):
        if file.is_symlink():
            raise ValueError('Installed release has a symbolic link')
        name = str(file.relative_to(target))
        if file.is_dir():
            if name not in expected_dirs:
                raise ValueError('Installed release file inventory mismatch')
            continue
        if not file.is_file():
            raise ValueError('Installed release has a special file')
        if name not in expected_modes:
            raise ValueError('Installed release file inventory mismatch')
        if (file.stat().st_mode & 0o777) != expected_modes[name]:
            raise ValueError('Installed release permission mismatch')
        installed[name] = sha(file.read_bytes())
        if len(installed) > 10000:
            raise ValueError('Too many installed release entries')
    if set(installed) != names or (target / MANIFEST_NAME).read_bytes() != manifest_bytes:
        raise ValueError('Installed release file inventory/manifest mismatch')
    if any(installed[name] != expected for name, expected in declared.items()):
        raise ValueError('Installed release content mismatch')
    return {
        'schema_version': 1,
        'status': 'installed-bytes-verified',
        'source_commit': lock['commit'],
        'release_sha256': lock['sha256'],
        'installed_path': str(target.resolve()),
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
    installer.add_argument('--destination', type=Path, required=True)
    verifier = sub.add_parser('verify')
    verifier.add_argument('--bundle', type=Path, required=True)
    verifier.add_argument('--lock', type=Path, required=True)
    verifier.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    if args.command == 'build':
        print(json.dumps(build(args.root, args.output), indent=2))
    elif args.command == 'install':
        print(install(args.bundle, json.loads(args.lock.read_text()), args.destination))
    else:
        print(json.dumps(verify_installation(args.bundle, json.loads(args.lock.read_text()), args.destination), indent=2))


if __name__ == '__main__':
    main()
