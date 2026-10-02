"""Explicit provider fallback with complete coverage accounting and bounded calls."""
import json
import os

from .core import PROMPT, chunks, combine, findings, segments
from .transport import RequestFailure, request


def review(diff, config, peers='', *, environ=None, requester=request):
    environ = os.environ if environ is None else environ
    parts = segments(diff)
    packed, omitted = chunks(parts, config['max_diff_chars'], config['max_chunks'])
    active = []
    for provider in config['providers']:
        credentials = list(dict.fromkeys(environ[name] for name in provider['credential_envs'] if environ.get(name)))
        if credentials:
            active.append((provider, credentials))
    result = {'schema_version': 1, 'status': 'complete', 'findings': [], 'reviewed_files': [],
              'omitted': omitted, 'calls': 0, 'failures': [], 'providers': []}
    if not active:
        result['status'] = 'unavailable'
        result['omitted'] += [{'path': path, 'reason': 'no-configured-credential'} for chunk in packed for path in chunk['files']]
        return result
    for index, chunk in enumerate(packed):
        chain = active[index % len(active):] + active[:index % len(active)] if config['strategy'] == 'crossprovider' else active
        accepted = False
        for provider, credentials in chain:
            if len(chunk['diff']) > provider['max_chars']:
                continue
            for credential in credentials:
                if result['calls'] >= config['max_calls']:
                    break
                payload = {'model': provider['model'], 'max_tokens': config['max_output_tokens'], 'temperature': 0.1,
                           'messages': [{'role': 'system', 'content': PROMPT}, {'role': 'user', 'content': json.dumps({'diff': chunk['diff'], 'peer_context': peers[:config['max_peer_chars']]})}]}
                result['calls'] += 1
                try:
                    response = requester(provider['endpoint'], credential, payload)
                    choices = response.get('choices') if isinstance(response, dict) else None
                    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                        raise ValueError('Malformed provider choices')
                    choice = choices[0]
                    if choice.get('finish_reason') != 'stop' or not isinstance(choice.get('message'), dict):
                        raise ValueError('Incomplete provider output')
                    content = choice['message']['content']
                    rows = findings(content, [p for p in parts if p['path'] in chunk['files']])
                except (RequestFailure, ValueError, KeyError, IndexError, TypeError):
                    result['failures'].append({'provider': provider['name'], 'chunk': index, 'reason': 'unavailable-or-invalid-response'})
                    continue
                result['findings'].extend(rows)
                result['reviewed_files'].extend(chunk['files'])
                result['providers'].append(provider['name'])
                accepted = True
                break
            if accepted:
                break
        if not accepted:
            result['omitted'] += [{'path': path, 'reason': 'provider-or-call-budget'} for path in chunk['files']]
    result['findings'] = combine(result['findings'])
    result['providers'] = list(dict.fromkeys(result['providers']))
    if result['omitted']:
        result['status'] = 'partial' if result['reviewed_files'] else 'unavailable'
    return result
