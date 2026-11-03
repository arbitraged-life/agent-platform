import hashlib
import json
import unittest

from scripts import trufflehog_gate


class TruffleHogGateTests(unittest.TestCase):
    def setUp(self):
        self.raw = 'synthetic fixture'
        self.disposition = {
            'commit': 'a' * 40,
            'file': 'tests/fixture.py',
            'line': 12,
            'detector': 'Postgres',
            'verified': False,
            'raw_sha256': hashlib.sha256(self.raw.encode()).hexdigest(),
        }
        self.result = {
            'DetectorName': 'Postgres',
            'Verified': False,
            'Raw': self.raw,
            'SourceMetadata': {
                'Data': {'Git': {
                    'commit': self.disposition['commit'],
                    'file': self.disposition['file'],
                    'line': self.disposition['line'],
                }}
            },
        }

    def test_disposes_only_an_exact_fingerprint_and_scan_finding_exit(self):
        output = json.dumps(self.result) + '\n'
        self.assertEqual(
            trufflehog_gate.validate_results(output, 183, self.disposition), 1
        )

    def test_unrecognized_finding_fails_closed(self):
        changed = dict(self.result, Raw=self.raw + ' changed')
        with self.assertRaisesRegex(ValueError, 'Unapproved'):
            trufflehog_gate.validate_results(json.dumps(changed), 183, self.disposition)

    def test_malformed_json_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'malformed'):
            trufflehog_gate.validate_results('{not-json}', 0, self.disposition)

    def test_scanner_error_fails_closed_even_with_a_finding(self):
        with self.assertRaisesRegex(ValueError, 'error diagnostic'):
            trufflehog_gate.validate_results('', 183, self.disposition, 'level=error')

    def test_scanner_error_fails_closed_even_without_findings(self):
        with self.assertRaisesRegex(ValueError, 'scanner failed'):
            trufflehog_gate.validate_results('', 2, self.disposition)

    def test_no_findings_requires_success_status(self):
        self.assertEqual(trufflehog_gate.validate_results('', 0, self.disposition), 0)

    def test_finding_with_success_status_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'exit status'):
            trufflehog_gate.validate_results(json.dumps(self.result), 0, self.disposition)

    def test_duplicate_disposition_fails_closed(self):
        output = '\n'.join([json.dumps(self.result), json.dumps(self.result)])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            trufflehog_gate.validate_results(output, 183, self.disposition)

    def test_pull_request_scans_exact_base_and_head_shas(self):
        payload = {
            'pull_request': {
                'base': {'sha': 'b' * 40},
                'head': {'sha': 'c' * 40},
            }
        }
        self.assertEqual(
            trufflehog_gate.scan_range('pull_request', payload, '', 'd' * 40),
            ('b' * 40, 'c' * 40),
        )

    def test_push_scans_before_and_after_commits(self):
        payload = {'before': '0' * 40, 'after': 'e' * 40, 'commits': [{'id': 'e' * 40}]}
        self.assertEqual(
            trufflehog_gate.scan_range('push', payload, '', 'e' * 40),
            ('', 'e' * 40),
        )

    def test_empty_push_skips_scan_like_pinned_action(self):
        self.assertEqual(
            trufflehog_gate.scan_range('push', {'before': 'f' * 40, 'after': 'f' * 40, 'commits': []}, '', 'f' * 40),
            (None, None),
        )


if __name__ == '__main__':
    unittest.main()
