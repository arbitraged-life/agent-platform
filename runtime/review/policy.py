"""Versioned configuration; destinations and credentials are consumer-owned."""
import re
from urllib.parse import urlsplit

DEFAULTS = {'max_diff_chars': 24000, 'max_chunks': 8, 'max_calls': 24,
            'max_output_tokens': 3000, 'max_peer_chars': 3500, 'strategy': 'crossprovider',
            'publish': False, 'inline_comments': True, 'peer_reviewers': [], 'commands': ['/review']}


def validate(value):
    if not isinstance(value, dict):
        raise ValueError('Review configuration must be an object')
    required = {'schema_version', 'repository', 'providers', 'publisher'}
    if required - value.keys() or value.keys() - (required | DEFAULTS.keys()):
        raise ValueError('Missing or unknown review configuration fields')
    config = {**DEFAULTS, **value}
    if type(config['schema_version']) is not int or config['schema_version'] != 1:
        raise ValueError('Unsupported review configuration version')
    if not isinstance(config['repository'], str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', config['repository']):
        raise ValueError('Invalid repository')
    for field, maximum in [('max_diff_chars', 120000), ('max_chunks', 32), ('max_calls', 100), ('max_output_tokens', 8192), ('max_peer_chars', 12000)]:
        if type(config[field]) is not int or not 1 <= config[field] <= maximum:
            raise ValueError(f'Invalid {field}')
    for field in ['publish', 'inline_comments']:
        if type(config[field]) is not bool:
            raise ValueError(f'Invalid {field}')
    if config['strategy'] not in ['sequential', 'crossprovider']:
        raise ValueError('Invalid review strategy')
    identities = [config['publisher']]
    if not isinstance(config['peer_reviewers'], list) or len(config['peer_reviewers']) > 30:
        raise ValueError('Invalid peer reviewers')
    identities += config['peer_reviewers']
    for identity in identities:
        if not isinstance(identity, dict) or set(identity) != {'id', 'login'} or type(identity['id']) is not int or identity['id'] < 1 or not isinstance(identity['login'], str) or not re.fullmatch(r'[A-Za-z0-9_-]+\[bot\]', identity['login']):
            raise ValueError('Invalid reviewer identity')
    if not isinstance(config['commands'], list) or not config['commands'] or any(not isinstance(c, str) or not re.fullmatch(r'/[a-z][a-z-]{0,30}', c) for c in config['commands']):
        raise ValueError('Invalid review commands')
    providers = config['providers']
    if not isinstance(providers, list) or not 1 <= len(providers) <= 12:
        raise ValueError('Configure one to twelve explicit providers')
    names = set()
    for provider in providers:
        fields = {'name', 'endpoint', 'model', 'credential_envs', 'max_chars'}
        if not isinstance(provider, dict) or set(provider) != fields:
            raise ValueError('Invalid provider fields')
        if not isinstance(provider['name'], str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', provider['name']) or provider['name'] in names:
            raise ValueError('Invalid or duplicate provider name')
        names.add(provider['name'])
        if not isinstance(provider['endpoint'], str):
            raise ValueError('Invalid provider endpoint')
        endpoint = urlsplit(provider['endpoint'])
        if endpoint.port is not None and not 1 <= endpoint.port <= 65535:
            raise ValueError('Invalid endpoint port')
        if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
            raise ValueError('Provider endpoint must be explicit HTTPS without credentials or query')
        if not isinstance(provider['model'], str) or not provider['model'].strip() or len(provider['model']) > 200:
            raise ValueError('Invalid provider model')
        if type(provider['max_chars']) is not int or not 1 <= provider['max_chars'] <= 120000:
            raise ValueError('Invalid provider budget')
        names_env = provider['credential_envs']
        if not isinstance(names_env, list) or not 1 <= len(names_env) <= 5 or any(not isinstance(n, str) or not re.fullmatch(r'[A-Z][A-Z0-9_]+', n) for n in names_env):
            raise ValueError('Invalid credential references')
    return config


def mapping(value):
    return value if isinstance(value, dict) else {}


def eligible(event_name, event, config):
    event = mapping(event)
    if mapping(event.get('repository')).get('full_name') != config['repository']:
        return None
    if event_name in ['pull_request', 'pull_request_target'] and event.get('action') in ['opened', 'synchronize', 'reopened']:
        pr = mapping(event.get('pull_request'))
        if mapping(pr.get('user')).get('type') == 'User' and not pr.get('draft'):
            return pr.get('number')
    issue = mapping(event.get('issue'))
    if event_name == 'issue_comment' and event.get('action') == 'created' and issue.get('pull_request'):
        comment = mapping(event.get('comment'))
        body = comment.get('body')
        command = body.strip().split() if isinstance(body, str) else []
        if mapping(comment.get('user')).get('type') == 'User' and comment.get('author_association') in ['OWNER', 'MEMBER', 'COLLABORATOR'] and command and command[0] in config['commands']:
            return issue.get('number')
    return None
