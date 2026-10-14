#!/usr/bin/env python3
"""Render public runtime architecture from tracked modules and import edges."""
import argparse
from pathlib import Path, PurePosixPath
import re
import shutil
# qlty-ignore(bandit:B404): Fixed, read-only Git argv inspect the staged index.
import subprocess

from architecture_excalidraw import identifier, render

ROOT = Path(__file__).resolve().parents[1]
GIT = shutil.which('git')
DOCUMENT = Path('docs/generated/runtime-map.md')
DRAWING = Path('docs/diagrams/runtime-map.excalidraw')
SUFFIXES = {'.mjs', '.py'}
ENTRYPOINTS = ('scripts/execution/', 'scripts/observability/', 'scripts/review/')


def git_output(root, *args):
    if not GIT:
        raise RuntimeError('Git is required to read staged architecture sources')
    # qlty-ignore(bandit:B603): Resolved Git executable, argv only, no shell.
    return subprocess.check_output([GIT, '-C', str(root), *args])


def tracked(root, staged):
    if staged:
        return sorted(part.decode() for part in git_output(root, 'ls-files', '-z').split(b'\0') if part)
    return sorted(str(path.relative_to(root)) for directory in ('runtime', 'scripts')
                  for path in (root / directory).rglob('*') if path.is_file())


def contents(root, name, staged):
    return git_output(root, 'show', ':' + name).decode() if staged else (root / name).read_text()


def sources(root, staged):
    names = tracked(root, staged)
    modules = [name for name in names if name.startswith('runtime/') and PurePosixPath(name).suffix in SUFFIXES and not name.endswith('/__init__.py')]
    entries = [name for name in names if (name.startswith(ENTRYPOINTS) or name == 'scripts/platform-release.py') and PurePosixPath(name).suffix in SUFFIXES]
    return modules, entries


def js_imports(name, body, known):
    found = set()
    for target in re.findall(r'''(?:from\s+|import\s*)['"]([^'"]+)['"]''', body):
        if target.startswith('.'):
            path = str(PurePosixPath(name).parent.joinpath(target))
            normalized = str(PurePosixPath(*_normalize(path.split('/'))))
            if normalized in known:
                found.add(normalized)
    return found


def python_imports(name, body, known):
    found = set()
    for target in re.findall(r'^from\s+(runtime(?:\.[a-zA-Z_][\w]*)+)\s+import\s+', body, re.M):
        path = target.replace('.', '/') + '.py'
        if path in known:
            found.add(path)
    for dots, target in re.findall(r'^from\s+(\.+)([a-zA-Z_][\w.]*)\s+import\s+', body, re.M):
        parent = PurePosixPath(name).parent
        for _ in range(len(dots) - 1):
            parent = parent.parent
        path = str(parent / (target.replace('.', '/') + '.py'))
        if path in known:
            found.add(path)
    return found


def imports(name, body, known):
    return sorted(js_imports(name, body, known) if name.endswith('.mjs')
                  else python_imports(name, body, known))


def _normalize(parts):
    result = []
    for part in parts:
        if part == '..':
            result.pop()
        elif part and part != '.':
            result.append(part)
    return result



def quote(value):
    return value.replace('"', "'")


def model(root, staged):
    modules, entries = sources(root, staged)
    known = set(modules)
    dependencies = {}
    for name in modules + entries:
        dependencies[name] = imports(name, contents(root, name, staged), known)
    return modules, entries, dependencies


def markdown(modules, entries, dependencies):
    domains = sorted({name.split('/')[1] for name in modules})
    out = ['# Generated public runtime map', '',
           'Generated from tracked `runtime/` modules and import statements by',
           '`scripts/generate_architecture.py`. Edges mean a statically resolved source',
           'import, not a deployed connection. Dynamic imports are not inferred. The',
           '[editable Excalidraw overview](../diagrams/runtime-map.excalidraw) has the',
           'domain-level view.', '',
           '## Entrypoints and runtime domains', '', '```mermaid', 'flowchart LR']
    for domain in domains:
        count = sum(name.startswith(f'runtime/{domain}/') for name in modules)
        out.append(f'    {identifier("domain:" + domain)}["{quote(domain)} · {count} module{"s" if count != 1 else ""}"]')
    for entry in entries:
        out.append(f'    {identifier(entry)}["{quote(PurePosixPath(entry).name)}"]')
    for entry in entries:
        for domain in sorted({path.split('/')[1] for path in dependencies[entry]}):
            out.append(f'    {identifier(entry)} --> {identifier("domain:" + domain)}')
    out += ['```', '', '## Module imports', '', '```mermaid', 'flowchart LR']
    for name in modules:
        out.append(f'    {identifier(name)}["{quote(name.removeprefix("runtime/"))}"]')
    for name in modules:
        for target in dependencies[name]:
            out.append(f'    {identifier(name)} --> {identifier(target)}')
    out += ['```', '', 'The generated views show source structure only. See',
            '[architecture and ownership](../architecture.md) for the release and',
            'consumer boundary, and the domain guides for behavior.', '']
    return '\n'.join(out)



def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--staged', action='store_true')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    if args.check == args.write:
        parser.error('choose exactly one of --check or --write')
    root = args.root.resolve()
    modules, entries, dependencies = model(root, args.staged)
    rendered = {DOCUMENT: markdown(modules, entries, dependencies),
                DRAWING: render(modules, entries, dependencies)}
    for path, body in rendered.items():
        target = root / path
        if args.write:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(body)
            print(f'updated {path}')
        elif not target.is_file() or target.read_text() != body:
            raise SystemExit(f'{path} is stale; run python3 scripts/generate_architecture.py --write')
    if args.check:
        print('Generated architecture maps are current.')


if __name__ == '__main__':
    main()
