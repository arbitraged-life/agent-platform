"""GitHub review publication: exact authorship, current head, no automatic approval."""
import html
import re

from .transport import request

MARKER = '<!-- agent-platform-review:v1 -->'


class PublisherMismatch(ValueError):
    pass


class GitHub:
    def __init__(self, repository, token, requester=request):
        self.prefix = '/repos/' + repository
        self.token = token
        self.requester = requester

    def call(self, path, method='GET', payload=None, *, max_bytes=1_048_576):
        return self.requester('https://api.github.com' + self.prefix + path,
                              self.token, payload, method=method, max_bytes=max_bytes)

    def assert_publisher(self, identity):
        response = self.requester('https://api.github.com/graphql', self.token,
                                  {'query': 'query { viewer { login databaseId } }'}, method='POST')
        if not isinstance(response, dict) or response.get('errors'):
            raise ValueError('Cannot establish authenticated publisher identity')
        data = response.get('data')
        viewer = data.get('viewer') if isinstance(data, dict) else None
        if not isinstance(viewer, dict) or type(viewer.get('databaseId')) is not int or not isinstance(viewer.get('login'), str):
            raise ValueError('Invalid authenticated publisher response')
        if not isinstance(viewer, dict) or viewer.get('login') != identity['login'] or viewer.get('databaseId') != identity['id']:
            raise PublisherMismatch('Authenticated publisher differs from policy')

    def all(self, path):
        result = []
        for page in range(1, 52):
            rows = self.call(f'{path}?per_page=20&page={page}', max_bytes=8_388_608)
            if not isinstance(rows, list) or len(rows) > 20 or len(result) + len(rows) > 1000:
                raise ValueError('Invalid GitHub pagination response')
            if any(not isinstance(row, dict) or (row.get('body') is not None and not isinstance(row['body'], str)) for row in rows):
                raise ValueError('Malformed GitHub record')
            result.extend(rows)
            if len(rows) < 20:
                return result
        raise ValueError('GitHub pagination limit reached')

    def snapshot(self, number):
        if type(number) is not int or number < 1:
            raise ValueError('Invalid pull request number')
        pr = self.call(f'/pulls/{number}')
        if pr.get('state') != 'open' or pr.get('draft') or pr.get('base', {}).get('repo', {}).get('full_name') != self.prefix[7:]:
            raise ValueError('Pull request is not eligible')
        for side in ['base', 'head']:
            if not re.fullmatch(r'[0-9a-f]{40}', pr.get(side, {}).get('sha', '')):
                raise ValueError('Invalid pull request commit')
        return {'number': number, 'base': pr['base']['sha'], 'head': pr['head']['sha']}

    def assert_current(self, snapshot):
        if self.snapshot(snapshot['number']) != snapshot:
            raise ValueError('Pull request changed; review publication refused')


def owned(record, identity):
    if not isinstance(record, dict):
        return False
    user = record.get('user')
    if not isinstance(user, dict):
        return False
    return user.get('type') == 'Bot' and user.get('id') == identity['id'] and user.get('login') == identity['login']


def peer_context(client, number, identities, limit):
    if not identities:
        return ''
    records = client.all(f'/issues/{number}/comments') + client.all(f'/pulls/{number}/reviews')
    parts = []
    remaining = limit
    for record in records:
        if not any(owned(record, identity) for identity in identities):
            continue
        body = record.get('body') or ''
        text = re.sub(r'<!--.*?-->', '', body, flags=re.DOTALL)[:remaining]
        parts.append(text)
        remaining -= len(text)
        if remaining <= 0:
            break
    return '\n'.join(parts)[:limit]


def render(result, head):
    rows = [MARKER, f'Review of `{head}`: **{result["status"]}**.',
            f'Reviewed files: {len(result["reviewed_files"])}. Omitted files: {len(result["omitted"])}.',
            'Advisory findings; no automatic approval.']
    for finding in result['findings']:
        location = f'{finding["path"]}:{finding["line"]}'
        rows += ['', f'**{finding["severity"]}**',
                 '<pre>' + html.escape(finding['title'] + '\n' + location + '\n\n' + finding['body']) + '</pre>']
    if not result['findings']:
        rows += ['', 'No findings returned for the reviewed portion. This is not proof of correctness.']
    if result['omitted']:
        rows += ['', 'Omitted from review:']
        rows.extend('<pre>' + html.escape(str(row['path']) + ': ' + row['reason']) + '</pre>' for row in result['omitted'])
    body = '\n'.join(rows)
    if len(body.encode()) > 60000:
        raise ValueError('Review exceeds comment limit; publication refused')
    return body


def publish(client, snapshot, result, config):
    if not config['publish']:
        return 'disabled'
    if result['status'] == 'unavailable':
        raise ValueError('No usable review; publication refused')
    number = snapshot['number']
    identity = config['publisher']
    client.assert_publisher(identity)
    body = render(result, snapshot['head'])
    comments = client.all(f'/issues/{number}/comments')
    candidates = [c for c in comments if owned(c, identity) and (c.get('body') or '').startswith(MARKER)]
    if len(candidates) > 1:
        raise ValueError('Ambiguous owned summary comments')
    client.assert_current(snapshot)
    if candidates:
        current = client.call(f'/issues/comments/{candidates[0]["id"]}')
        if not owned(current, identity) or not (current.get('body') or '').startswith(MARKER):
            raise ValueError('Summary comment ownership changed')
        client.assert_current(snapshot)
        response = client.call(f'/issues/comments/{current["id"]}', 'PATCH', {'body': body})
    else:
        response = client.call(f'/issues/{number}/comments', 'POST', {'body': body})
    if not owned(response, identity):
        raise ValueError('Published comment identity differs from configured publisher')
    inline = [row for row in result['findings'] if row['inline']][:25]
    if config['inline_comments'] and inline:
        reviews = client.all(f'/pulls/{number}/reviews')
        # Existing same-head review is immutable evidence, not something to
        # delete and recreate. Workflow concurrency serializes same-PR runs.
        prior = [r for r in reviews if owned(r, identity) and r.get('commit_id') == snapshot['head'] and (r.get('body') or '').startswith(MARKER)]
        if not prior:
            client.assert_current(snapshot)
            response = client.call(f'/pulls/{number}/reviews', 'POST', {
                'commit_id': snapshot['head'], 'event': 'COMMENT', 'body': MARKER + '\n' + 'Advisory findings; coverage is recorded in the summary.',
                'comments': [{'path': row['path'], 'line': row['line'], 'side': 'RIGHT',
                              'body': '<pre>' + html.escape(row['title'] + '\n\n' + row['body']) + '</pre>'} for row in inline]})
            if not owned(response, identity):
                raise ValueError('Published review identity differs from configured publisher')
    return 'published'
