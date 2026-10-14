"""Deterministic editable Excalidraw shapes for the public runtime map."""
import hashlib
import json
from pathlib import PurePosixPath


def identifier(value):
    return 'n' + hashlib.sha256(value.encode()).hexdigest()[:12]


def element(key, kind, bounds, *, label='', color='#1e3a5f', fill='#eff6ff', points=None):
    x, y, width, height = bounds
    seed = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)
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


def render(modules, entries, dependencies):
    domains = sorted({name.split('/')[1] for name in modules})
    shapes = [element('title', 'text', (40, 20, 1100, 45),
                      label='AGENT PLATFORM / PUBLIC RUNTIME IMPORTS')]
    positions = {}
    for index, entry in enumerate(entries):
        x, y = 40, 95 + index * 72
        positions[entry] = (x + 230, y + 25)
        shapes += [element('box:' + entry, 'rectangle', (x, y, 230, 52)),
                   element('label:' + entry, 'text', (x + 8, y + 10, 214, 30),
                           label=PurePosixPath(entry).name)]
    for index, domain in enumerate(domains):
        x, y = 620, 95 + index * 96
        positions[domain] = (x, y + 32)
        count = sum(name.startswith(f'runtime/{domain}/') for name in modules)
        shapes += [element('box:' + domain, 'rectangle', (x, y, 310, 65),
                           color='#0f766e', fill='#ecfdf5'),
                   element('label:' + domain, 'text', (x + 10, y + 13, 290, 38),
                           label=f'{domain} ({count} module{"s" if count != 1 else ""})',
                           color='#0f766e')]
    for entry in entries:
        for domain in sorted({path.split('/')[1] for path in dependencies[entry]}):
            sx, sy = positions[entry]
            tx, ty = positions[domain]
            shapes.append(element('edge:' + entry + ':' + domain, 'arrow',
                                  (sx, sy, tx - sx, ty - sy),
                                  points=[[0, 0], [tx - sx, ty - sy]], color='#64748b'))
    return json.dumps({'type': 'excalidraw', 'version': 2,
                       'source': 'agent-platform/scripts/generate_architecture.py',
                       'elements': shapes, 'appState': {'viewBackgroundColor': '#ffffff'},
                       'files': {}}, indent=2, ensure_ascii=False) + '\n'
