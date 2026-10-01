#!/usr/bin/env python3
"""Discover the release's skills and verify its pinned upstream content."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def contained_file(root, name):
    if not isinstance(name, str) or not name or '\\' in name:
        raise ValueError('Invalid skill path')
    relative = Path(name)
    if relative.is_absolute() or any(part in {'.', '..'} for part in name.split('/')):
        raise ValueError('Skill path escapes its bundle')
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Skill path must be a bundled regular file')
    return path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def catalog(root=ROOT):
    document = json.loads((root / 'skills/catalog.json').read_text())
    if type(document.get('schema_version')) is not int or document['schema_version'] != 1:
        raise ValueError('Unsupported skill catalog')
    rows = document.get('skills')
    if not isinstance(rows, list) or not rows:
        raise ValueError('Skill catalog must contain entries')
    names = set()
    for row in rows:
        if set(row) != {'name', 'description', 'path', 'license'}:
            raise ValueError('Unknown or missing skill catalog field')
        name = row['name']
        if not isinstance(name, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name) or name in names:
            raise ValueError('Invalid or duplicate skill name')
        names.add(name)
        if not isinstance(row['description'], str) or not row['description'].strip():
            raise ValueError('Skill description required')
        if row['path'] != 'skills/' + name + '/SKILL.md':
            raise ValueError('Skill entrypoint does not match its name')
        contained_file(root, row['path'])
        contained_file(root, row['license'])
    return rows


def verify_upstream(root=ROOT):
    lock = json.loads((root / 'skills/upstream-lock.json').read_text())
    if type(lock.get('schema_version')) is not int or lock['schema_version'] != 1:
        raise ValueError('Unsupported upstream skill lock')
    if not re.fullmatch(r'[0-9a-f]{40}', lock['commit']):
        raise ValueError('Upstream commit must be immutable')
    if sha(contained_file(root, lock['license_path'])) != lock['license_sha256']:
        raise ValueError('Upstream license changed')
    names = {row['name'] for row in catalog(root)}
    if (not isinstance(lock['skills'], list) or len(set(lock['skills'])) != len(lock['skills'])
            or not set(lock['skills']).issubset(names)):
        raise ValueError('Upstream skill names must match catalog entries')
    actual = {str(p.relative_to(root)) for name in lock['skills']
              for p in (root / 'skills' / name).rglob('*') if p.is_file()}
    if actual != set(lock['files']):
        raise ValueError('Upstream file inventory changed')
    for name, hashes in lock['files'].items():
        if sha(contained_file(root, name)) != hashes['sha256']:
            raise ValueError('Upstream skill content changed: ' + name)
        if not re.fullmatch(r'[0-9a-f]{64}', hashes['upstream_sha256']):
            raise ValueError('Invalid upstream file hash')
        if hashes['sha256'] != hashes['upstream_sha256']:
            overlay = lock['overlays'].get(name, {})
            if overlay.get('sha256') != hashes['sha256'] or not overlay.get('reason'):
                raise ValueError('Changed upstream content requires an explicit overlay')
    if not set(lock['overlays']).issubset(lock['files']):
        raise ValueError('Overlay is absent from the upstream inventory')
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list', 'validate'], nargs='?', default='list')
    args = parser.parse_args()
    rows = catalog()
    if args.command == 'validate':
        verify_upstream()
        print('Skill catalog, upstream file hashes, overlays, and licensing passed.')
    else:
        print(json.dumps(rows, indent=2))


if __name__ == '__main__':
    main()
