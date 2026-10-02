import json
import http.client
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime.review.engine import review
from runtime.review.github import GitHub, publish, MARKER, owned, PublisherMismatch
from scripts.review.review import diff_at
from runtime.review.policy import eligible, validate
from runtime.review.core import chunks, combine, findings, segments
from runtime.review.transport import NoRedirect, RequestFailure, request


class ReviewContracts(unittest.TestCase):
    def diff(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output([shutil.which('git'), '-C', directory, *args], text=True)
            git('init', '-q')
            (root / 'name with spaces.py').write_text('before\n')
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
            (root / 'name with spaces.py').write_text('after\nsecond\n')
            return git('-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv')

    def test_real_git_diff_and_strict_findings(self):
        parts = segments(self.diff())
        self.assertEqual(parts[0]['path'], 'name with spaces.py')
        self.assertEqual(parts[0]['added'], {1, 2})
        row = {'path': parts[0]['path'], 'line': 2, 'severity': 'high', 'title': 'Defect', 'body': 'Evidence'}
        self.assertTrue(findings(json.dumps({'findings': [row]}), parts)[0]['inline'])
        for content in ['No blocking issues.', '{"findings": [], "approve": true}', json.dumps({'findings': [{**row, 'path': 'absent'}]})]:
            with self.assertRaises(ValueError):
                findings(content, parts)

    def test_budget_coverage_never_claims_truncated_files(self):
        parts = segments(self.diff())
        second = {**parts[0], 'path': 'another.py'}
        packed, omitted = chunks(parts + [second], len(parts[0]['text']), 1)
        self.assertEqual(len(packed), 1)
        self.assertEqual(omitted, [{'path': 'another.py', 'reason': 'chunk-budget'}])
        packed, omitted = chunks(parts, 1, 1)
        self.assertEqual(packed, [])
        self.assertEqual(omitted[0]['reason'], 'file-exceeds-budget')

    def test_synthesis_preserves_distinct_evidence(self):
        base = {'path': 'a', 'line': 1, 'severity': 'low', 'title': 'Bug', 'body': 'Evidence', 'inline': True}
        result = combine([base, {**base, 'severity': 'high'}, {**base, 'body': 'Different evidence'}])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['severity'], 'high')

    def test_redirects_are_never_followed(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.invalid'))

    def test_transport_bounds_and_sanitizes_failures(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return b'x' * limit
        with patch('urllib.request.OpenerDirector.open', return_value=Response()):
            with self.assertRaises(RequestFailure) as caught:
                request('https://example.invalid', 'synthetic', {}, max_bytes=10)
            self.assertNotIn('synthetic', str(caught.exception))
        with patch('urllib.request.OpenerDirector.open', side_effect=OSError('private response')):
            with self.assertRaises(RequestFailure) as caught:
                request('https://example.invalid', 'synthetic', {})
            self.assertNotIn('private response', str(caught.exception))


class ReviewExecution(unittest.TestCase):
    diff = ReviewContracts.diff
    def config(self):
        return validate({'schema_version': 1, 'repository': 'example/project',
                         'publisher': {'id': 1, 'login': 'review[bot]'},
                         'providers': [{'name': 'first', 'endpoint': 'https://first.example.invalid/chat',
                                        'model': 'fixture', 'credential_envs': ['FIRST_KEY'], 'max_chars': 24000},
                                       {'name': 'second', 'endpoint': 'https://second.example.invalid/chat',
                                        'model': 'fixture', 'credential_envs': ['SECOND_KEY'], 'max_chars': 24000}]})

    def test_explicit_fallback_and_no_credential_activation(self):
        calls = []
        def requester(url, token, payload):
            calls.append(url)
            if len(calls) == 1:
                raise RequestFailure(429)
            return {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"findings": []}'}}]}
        result = review(self.diff(), self.config(), environ={'FIRST_KEY': 'synthetic', 'SECOND_KEY': 'synthetic'}, requester=requester)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['calls'], 2)
        self.assertEqual(result['providers'], ['second'])
        result = review(self.diff(), self.config(), environ={'UNCONFIGURED_KEY': 'synthetic'}, requester=requester)
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(len(calls), 2)

    def test_truncated_or_prose_responses_never_mean_clean(self):
        for reason, content in [('length', '{"findings": []}'), ('stop', 'No blocking issues.')]:
            result = review(self.diff(), self.config(), environ={'FIRST_KEY': 'synthetic'}, requester=lambda *a: {'choices': [{'finish_reason': reason, 'message': {'content': content}}]})
            self.assertEqual(result['status'], 'unavailable')
            self.assertEqual(result['reviewed_files'], [])

    def test_config_and_event_fail_closed(self):
        config = self.config()
        with self.assertRaises(ValueError):
            validate({**config, 'max_calls': True})
        with self.assertRaises(ValueError):
            validate({**config, 'unknown': 1})
        with self.assertRaises(ValueError):
            validate({**config, 'publisher': {'id': 2, 'login': 'human'}})
        event = {'repository': {'full_name': 'example/project'}, 'action': 'created',
                 'issue': {'number': 2, 'pull_request': {'url': 'https://example.invalid'}},
                 'comment': {'body': '/review', 'user': {'type': 'User'}, 'author_association': 'NONE'}}
        self.assertIsNone(eligible('issue_comment', event, config))
        event['comment']['author_association'] = 'OWNER'
        self.assertEqual(eligible('issue_comment', event, config), 2)
        event['comment']['user']['type'] = 'Bot'
        self.assertIsNone(eligible('issue_comment', event, config))

    def test_forged_marker_not_updated_and_stale_head_refused(self):
        class Client:
            def __init__(self, stale=False): self.writes = []; self.stale = stale
            def assert_publisher(self, identity): pass
            def all(self, path): return [{'id': 3, 'body': MARKER, 'user': {'type': 'User', 'id': 4, 'login': 'other'}}]
            def assert_current(self, snapshot):
                if self.stale: raise ValueError('stale')
            def call(self, path, method='GET', payload=None):
                self.writes.append((path, method))
                return {'user': {'type': 'Bot', 'id': 1, 'login': 'review[bot]'}}
        config = {**self.config(), 'publish': True}
        result = {'status': 'complete', 'findings': [], 'reviewed_files': ['file'], 'omitted': []}
        snapshot = {'number': 2, 'head': 'a' * 40, 'base': 'b' * 40}
        client = Client()
        publish(client, snapshot, result, config)
        self.assertEqual(client.writes, [('/issues/2/comments', 'POST')])
        client = Client(stale=True)
        with self.assertRaises(ValueError): publish(client, snapshot, result, config)
        self.assertEqual(client.writes, [])


    def test_bad_response_fallback(self):
        responses = iter([{'choices': [None]}, {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"findings": []}'}}]}])
        result = review(self.diff(), self.config(), environ={'FIRST_KEY': 'synthetic', 'SECOND_KEY': 'synthetic'}, requester=lambda *args: next(responses))
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['providers'], ['second'])

    def test_wrong_token_identity_performs_zero_writes(self):
        calls = []
        def requester(url, token, payload, **kwargs):
            calls.append(url)
            if url.endswith('/graphql'):
                return {'data': {'viewer': {'databaseId': 3, 'login': 'other[bot]'}}}
            if url.endswith('/pulls/2'):
                return {'state': 'open', 'base': {'sha': 'b' * 40, 'repo': {'full_name': 'example/project'}}, 'head': {'sha': 'a' * 40}}
            if kwargs.get('method') == 'GET':
                return []
            return {'user': {'type': 'Bot', 'id': 3, 'login': 'other[bot]'}}
        client = GitHub('example/project', 'synthetic', requester)
        with self.assertRaises(ValueError):
            publish(client, {'number': 2, 'head': 'a' * 40, 'base': 'b' * 40},
                    {'status': 'complete', 'findings': [], 'reviewed_files': ['file'], 'omitted': []},
                    {**self.config(), 'publish': True})
        self.assertEqual(calls, ['https://api.github.com/graphql'])

    def test_gitlink_changes_survive_inherited_ignore_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            def git(*args):
                return subprocess.check_output([shutil.which('git'), '-C', directory, *args], text=True).strip()
            git('init', '-q')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'initial')
            initial = git('rev-parse', 'HEAD')
            git('update-index', '--add', '--cacheinfo', '160000,' + initial + ',module')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'module')
            base = git('rev-parse', 'HEAD')
            git('update-index', '--cacheinfo', '160000,' + base + ',module')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'update module')
            head = git('rev-parse', 'HEAD')
            git('config', 'diff.ignoreSubmodules', 'all')
            diff = diff_at(directory, {'base': base, 'head': head})
            parts = segments(diff)
            self.assertEqual([part['path'] for part in parts], ['module'])
            self.assertIn('Subproject commit', parts[0]['text'])


    def test_non_utf8_file_is_omitted_without_lossy_review(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output([shutil.which('git'), '-C', directory, *args], text=True).strip()
            git('init', '-q')
            (root / 'legacy.txt').write_bytes(b'before')
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'before')
            base = git('rev-parse', 'HEAD')
            (root / 'legacy.txt').write_bytes(bytes([255, 254, 10]))
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'after')
            parts = segments(diff_at(directory, {'base': base, 'head': git('rev-parse', 'HEAD')}))
            packed, omitted = chunks(parts, 24000, 8)
            self.assertEqual(packed, [])
            self.assertEqual(omitted, [{'path': 'legacy.txt', 'reason': 'binary-or-unsupported'}])
            with self.assertRaisesRegex(ValueError, 'ceiling'):
                diff_at(directory, {'base': base, 'head': git('rev-parse', 'HEAD')}, max_bytes=8)


    def test_attributes_cannot_hide_text_and_binary_is_omitted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output([shutil.which('git'), '-C', directory, *args], text=True).strip()
            git('init', '-q')
            (root / '.gitattributes').write_text('hidden.txt -diff\n')
            (root / 'hidden.txt').write_text('before\n')
            (root / 'binary.dat').write_bytes(b'before\0')
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'before')
            base = git('rev-parse', 'HEAD')
            (root / 'hidden.txt').write_text('after\n')
            (root / 'binary.dat').write_bytes(b'after\0')
            git('add', '.')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'after')
            packed, omitted = chunks(segments(diff_at(directory, {'base': base, 'head': git('rev-parse', 'HEAD')})), 24000, 8)
            self.assertEqual(packed[0]['files'], ['hidden.txt'])
            self.assertIn('+after', packed[0]['diff'])
            self.assertEqual(omitted, [{'path': 'binary.dat', 'reason': 'binary-or-unsupported'}])

    def test_unicode_line_separators_do_not_shift_git_anchors(self):
        diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1,2 @@\n+first\u2028+fake\n+second\n'
        self.assertEqual(segments(diff)[0]['added'], {1, 2})

    def test_nested_json_and_http_errors_are_bounded_failures(self):
        with self.assertRaises(ValueError):
            findings('[' * 2000 + ']' * 2000, [])
        for error in (http.client.IncompleteRead(b'private'), RecursionError('private')):
            with patch('urllib.request.OpenerDirector.open', side_effect=error):
                with self.assertRaises(RequestFailure):
                    request('https://example.invalid', 'synthetic', {})

    def test_no_credentials_counts_each_omission_once(self):
        diff = self.diff() + 'diff --git a/opaque b/opaque\n--- a/opaque\n+++ b/opaque\n@@ -0,0 +1 @@\n+' + 'x' * 25000 + '\n'
        result = review(diff, self.config(), environ={})
        self.assertEqual(len(result['omitted']), 2)

    def test_invalid_events_ports_and_deleted_users(self):
        config = self.config()
        for event in (None, [], {'repository': None}, {'repository': {'full_name': 'example/project'}, 'issue': None, 'comment': None}):
            self.assertIsNone(eligible('issue_comment', event, config))
        for port in ('bad', '0', '65536'):
            provider = {**config['providers'][0], 'endpoint': 'https://example.invalid:' + port}
            with self.assertRaises(ValueError):
                validate({**config, 'providers': [provider]})
        self.assertFalse(owned({'user': None}, config['publisher']))

    def test_pagination_includes_exact_boundary_and_rejects_overflow(self):
        for count in (999, 1000, 1001):
            def requester(url, token, payload, **kwargs):
                self.assertEqual(kwargs['max_bytes'], 8388608)
                page = int(url.rsplit('=', 1)[1])
                return [{'body': 'x' * 60000}] * max(0, min(20, count - (page - 1) * 20))
            client = GitHub('example/project', 'synthetic', requester)
            if count > 1000:
                with self.assertRaises(ValueError): client.all('/issues/2/comments')
            else:
                self.assertEqual(len(client.all('/issues/2/comments')), count)

    def test_identity_transport_failure_is_not_a_mismatch(self):
        client = GitHub('example/project', 'synthetic', lambda *args, **kw: {'errors': ['unavailable']})
        with self.assertRaises(ValueError) as caught:
            client.assert_publisher(self.config()['publisher'])
        self.assertNotIsInstance(caught.exception, PublisherMismatch)


    def test_invalid_lines_and_malformed_records_fail_closed(self):
        parts = segments(self.diff())
        for line in (0, 999):
            row = {'path': parts[0]['path'], 'line': line, 'severity': 'high', 'title': 'Defect', 'body': 'Evidence'}
            with self.assertRaises(ValueError): findings(json.dumps({'findings': [row]}), parts)
        self.assertFalse(owned(None, self.config()['publisher']))
        for row in (None, [], {'body': 12}):
            client = GitHub('example/project', 'synthetic', lambda *args, **kw: [row])
            with self.assertRaises(ValueError): client.all('/issues/2/comments')


if __name__ == '__main__':
    unittest.main()
