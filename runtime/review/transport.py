"""Bounded HTTPS with no redirect forwarding or raw upstream error logging."""
import json
import urllib.error
import urllib.parse
import urllib.request


class RequestFailure(Exception):
    def __init__(self, status=None):
        self.status = status
        super().__init__('Remote request failed' + (f' (HTTP {status})' if status else ''))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token, payload=None, *, method='POST', timeout=45, max_bytes=1_048_576):
    endpoint = urllib.parse.urlsplit(url)
    if endpoint.scheme != 'https' or not endpoint.hostname or endpoint.username or endpoint.password or endpoint.fragment:
        raise ValueError('HTTPS endpoint required')
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json',
               'Accept': 'application/json', 'User-Agent': 'agent-platform-review/1',
               'X-GitHub-Api-Version': '2022-11-28'}
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(url, headers=headers, data=data, method=method)
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            raw = response.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise RequestFailure()
            return json.loads(raw.decode('utf-8')) if raw else None
    except urllib.error.HTTPError as error:
        status = error.code
        error.close()
        raise RequestFailure(status) from None
    except (OSError, UnicodeError, ValueError):
        raise RequestFailure() from None
