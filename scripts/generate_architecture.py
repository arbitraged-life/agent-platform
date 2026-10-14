#!/usr/bin/env python3
"""Render public runtime architecture from tracked modules and import edges."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
DOCUMENT = Path('docs/generated/runtime-map.md')
DRAWING = Path('docs/diagrams/runtime-map.excalidraw')
SUFFIXES = {'.mjs', '.py'}
ENTRYPOINTS = ('scripts/execution/', 'scripts/observability/', 'scripts/review/')


def tracked(root, staged):
    if staged:
        result = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
        return sorted(path.decode() for path in result.split(b'\0') if path)
    return sorted(str(path.relative_to(root)) for directory in ('runtime', 'scripts')
                  for path in (root / directory).rglob('*') if path.is_file())


def contents(root, name, staged):
    if staged:
        return subprocess.check_output(['git', '-C', str(root), 'show', ':' + name]).decode()
    return (root / name).read_text()


def sources(root, staged):
    names = tracked(root, staged)
    modules = [name for name in names if name.startswith('runtime/') and PurePosixPath(name).suffix in SUFFIXES and not name.endswith('/__init__.py')]
    entries = [name for name in names if (name.startswith(ENTRYPOINTS) or name == 'scripts/platform-release.py') and PurePosixPath(name).suffix in SUFFIXES]
    return modules, entries


def imports(name, body, known):
    found = set()
    if name.endswith('.mjs'):
        for target in re.findall(r'''(?:from\s+|import\s*)['"]([^'"]+)['"]''', body):
            if target.startswith('.'):
                path = str(PurePosixPath(name).parent.joinpath(target))
                normalized = str(PurePosixPath(*_normalize(path.split('/'))))
                if normalized in known:
                    found.add(normalized)
    else:
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
    return sorted(found)


def _normalize(parts):
    result = []
    for part in parts:
        if part == '..':
            result.pop()
        elif part and part != '.':
            result.append(part)
    return result


def identifier(value):
    return 'n' + hashlib.sha1(value.encode()).hexdigest()[:12]


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


def element(key, kind, x, y, width, height, *, label='', color='#1e3a5f', fill='#eff6ff', points=None):
    seed = int(hashlib.sha1(key.encode()).hexdigest()[:8], 16)
    item = {'id': identifier(key), 'type': kind, 'x': x, 'y': y, 'width': width,
            'height': height, 'angle': 0, 'strokeColor': color,
            'backgroundColor': fill if kind == 'rectangle' else 'transparent',
            'fillStyle': 'solid', 'strokeWidth': 2 if kind != 'text' else 1,
            'strokeStyle': 'solid', 'roughness': 0, 'opacity': 100, 'seed': seed,
            'version': 1, 'versionNonce': seed, 'isDeleted': False,
            'groupIds': [], 'frameId': None, 'boundElements': None,
            'link': None, 'locked': False}
    if kind == 'text':
        item.update({'text': label, 'originalText': label, 'fontSize': 15,
                     'fontFamily': 2, 'textAlign': 'center', 'verticalAlign': 'middle',
                     'lineHeight': 1.25, 'autoResize': False})
    if kind == 'arrow':
        item.update({'points': points, 'startBinding': None, 'endBinding': None,
                     'startArrowhead': None, 'endArrowhead': 'arrow', 'roundness': None})
    if kind == 'rectangle':
        item['roundness'] = {'type': 3}
    return item


def excalidraw(modules, entries, dependencies):
    domains = sorted({name.split('/')[1] for name in modules})
    elements = [element('title', 'text', 40, 20, 1100, 45,
                        label='AGENT PLATFORM / PUBLIC RUNTIME IMPORTS')]
    positions = {}
    for index, entry in enumerate(entries):
        x, y = 40, 95 + index * 72
        positions[entry] = (x + 230, y + 25)
        elements += [element('box:' + entry, 'rectangle', x, y, 230, 52),
                     element('label:' + entry, 'text', x + 8, y + 10, 214, 30,
                             label=PurePosixPath(entry).name)]
    for index, domain in enumerate(domains):
        x, y = 620, 95 + index * 96
        positions[domain] = (x, y + 32)
        count = sum(name.startswith(f'runtime/{domain}/') for name in modules)
        elements += [element('box:' + domain, 'rectangle', x, y, 310, 65,
                             color='#0f766e', fill='#ecfdf5'),
                     element('label:' + domain, 'text', x + 10, y + 13, 290, 38,
                             label=f'{domain} ({count} module{"s" if count != 1 else ""})', color='#0f766e')]
    for entry in entries:
        for domain in sorted({path.split('/')[1] for path in dependencies[entry]}):
            sx, sy = positions[entry]
            tx, ty = positions[domain]
            elements.append(element('edge:' + entry + ':' + domain, 'arrow', sx, sy,
                                    tx - sx, ty - sy, points=[[0, 0], [tx - sx, ty - sy]],
                                    color='#64748b'))
    return json.dumps({'type': 'excalidraw', 'version': 2,
                       'source': 'agent-platform/scripts/generate_architecture.py',
                       'elements': elements, 'appState': {'viewBackgroundColor': '#ffffff'},
                       'files': {}}, indent=2, ensure_ascii=False) + '\n'


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
                DRAWING: excalidraw(modules, entries, dependencies)}
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
