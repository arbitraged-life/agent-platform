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


GIT_EXECUTABLE = shutil.which('git')


MANIFEST_NAME = 'release-manifest.json'
MAX_RELEASE_BYTES = 64 * 1024 * 1024

def sha(data):
    return hashlib.sha256(data).hexdigest()


def build(root, output):
    if GIT_EXECUTABLE is None:
        raise RuntimeError('git executable is required to build a release')
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    if subprocess.check_output([GIT_EXECUTABLE, '-C', str(root), 'status', '--porcelain'], text=True).strip():
        raise ValueError('Release build requires a clean working tree')
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    commit = subprocess.check_output([GIT_EXECUTABLE, '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    files, modes = {}, {}
    # qlty-ignore(bandit:B603): Resolved executable and literal argv; shell interpretation is disabled.
    committed = subprocess.check_output([GIT_EXECUTABLE, '-c', 'tar.umask=0000', '-C', str(root), 'archive', '--format=tar', commit])
    with tarfile.open(fileobj=io.BytesIO(committed)) as source:
        for member in source:
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f'Unsupported release entry: {member.name}')
            if member.name == MANIFEST_NAME:
                raise ValueError('Reserved release manifest in source')
            files[member.name] = source.extractfile(member).read()
            modes[member.name] = 0o755 if member.mode & 0o111 else 0o644
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
        os.replace(temporary, output)
        return {'schema_version': 1, 'commit': commit, 'sha256': digest, 'artifact': output.name}
    finally:
        temporary.unlink(missing_ok=True)



def _extract_bundle(data, temporary):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        total = 0
        members = archive.getmembers()
        if len(members) > 10000:
            raise ValueError('Too many release entries')
        seen = set()
        for member in members:
            name = PurePosixPath(member.name)
            if not member.isfile() or name.is_absolute() or PureWindowsPath(member.name).drive or '..' in name.parts or '\\' in member.name or ':' in member.name or str(name) in seen:
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


def install(bundle, lock, destination):
    if set(lock) != {'schema_version', 'commit', 'sha256', 'artifact'} or lock['schema_version'] != 1:
        raise ValueError('Unsupported release lock')
    if not re.fullmatch('[0-9a-f]{40}', lock['commit']) or not re.fullmatch('[0-9a-f]{64}', lock['sha256']):
        raise ValueError('Invalid release identity')
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
    try:
        _extract_bundle(data, temporary)
        manifest = json.loads((temporary / MANIFEST_NAME).read_text())
        if manifest.get('schema_version') != 1 or manifest.get('commit') != lock['commit']:
            raise ValueError('Release manifest identity mismatch')
        actual = {str(p.relative_to(temporary)): sha(p.read_bytes()) for p in temporary.rglob('*') if p.is_file() and p != temporary / MANIFEST_NAME}
        if actual != manifest.get('files'):
            raise ValueError('Release content manifest mismatch')
        os.rename(temporary, target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return target


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
    args = parser.parse_args()
    if args.command == 'build':
        print(json.dumps(build(args.root, args.output), indent=2))
    else:
        print(install(args.bundle, json.loads(args.lock.read_text()), args.destination))


if __name__ == '__main__':
    main()
