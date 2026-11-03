#!/usr/bin/env python3
"""Run pinned TruffleHog JSON scanning and disposition one proven fixture result."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

SCANNER_IMAGE = (
    'ghcr.io/trufflesecurity/trufflehog@'
    'sha256:0d003fc3abc4e1565eca8462b992001314de51451e96e3c44de80d116794d5d1'
)
KNOWN_DISPOSITION = {
    'commit': '2b5480c06a19fc7fcca897dfd665547ec37ebf5b',
    'file': 'tests/unit/observability-otlp.test.mjs',
    'line': 198,
    'detector': 'Postgres',
    'verified': False,
    'raw_sha256': '77ee058852a8b28d1b4348284e46912c1b91282f6494e3d859d674346187fa08',
}


def parse_results(output):
    results = []
    for number, line in enumerate(output.splitlines(), 1):
        if not line.strip():
            continue
        try:
            result = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f'malformed TruffleHog JSON at output line {number}') from exc
        if not isinstance(result, dict):
            raise ValueError(f'invalid TruffleHog result at output line {number}')
        results.append(result)
    return results


def is_known_finding(result, disposition=KNOWN_DISPOSITION):
    metadata = result.get('SourceMetadata')
    git = metadata.get('Data', {}).get('Git', {}) if isinstance(metadata, dict) else {}
    raw = result.get('Raw')
    if not isinstance(raw, str) or not isinstance(git, dict):
        return False
    fingerprint = {
        'commit': git.get('commit'),
        'file': git.get('file'),
        'line': git.get('line'),
        'detector': result.get('DetectorName'),
        'verified': result.get('Verified'),
        'raw_sha256': hashlib.sha256(raw.encode('utf-8')).hexdigest(),
    }
    return fingerprint == disposition


def validate_results(output, returncode, disposition=KNOWN_DISPOSITION, diagnostics=''):
    if any(word in diagnostics.lower() for word in ('error', 'fatal')):
        raise ValueError('TruffleHog emitted an error diagnostic')
    results = parse_results(output)
    if returncode not in (0, 183):
        raise ValueError(f'TruffleHog scanner failed with exit code {returncode}')
    if (returncode == 0) != (not results):
        raise ValueError('TruffleHog exit status did not match its JSON findings')
    unapproved = sum(not is_known_finding(result, disposition) for result in results)
    if unapproved:
        raise ValueError(f'Unapproved TruffleHog finding(s): {unapproved}')
    if len(results) > 1:
        raise ValueError('Duplicate finding-specific disposition; refusing repeated result')
    return len(results)


def scan_range(event, payload, manual_base, head):
    if not isinstance(payload, dict):
        raise ValueError('Invalid GitHub event payload')
    if event == 'pull_request':
        pr = payload.get('pull_request', {})
        base = pr.get('base', {}).get('sha', '')
        head = pr.get('head', {}).get('sha', '')
    elif event == 'push':
        commits = payload.get('commits')
        if not isinstance(commits, list):
            raise ValueError('Invalid push commit list')
        if not commits:
            return None, None
        base = payload.get('before', '')
        head = payload.get('after', '')
        if base == '0' * len(head):
            base = ''
    elif event == 'workflow_dispatch':
        base = manual_base
    else:
        raise ValueError(f'Unsupported scanner event: {event}')
    if not isinstance(base, str) or not isinstance(head, str) or not head:
        raise ValueError('Invalid scanner commit range')
    return base, head


def main():
    try:
        event = os.environ['GITHUB_EVENT_NAME']
        payload = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        base, head = scan_range(
            event, payload, os.environ.get('TRUFFLEHOG_MANUAL_BASE', ''), os.environ['GITHUB_SHA']
        )
        if head is None:
            print('TruffleHog passed: push contained no commits to scan.')
            return 0
        workspace = Path(os.environ['GITHUB_WORKSPACE']).resolve()
        command = [
            'docker', 'run', '--rm', '-v', f'{workspace}:/workspace:ro', '-w', '/workspace',
            SCANNER_IMAGE, 'git', 'file:///workspace/', '--since-commit', base,
            '--branch', head, '--fail', '--no-update', '--json', '--no-verification',
        ]
        scan = subprocess.run(command, capture_output=True, text=True, check=False)
        disposition_count = validate_results(scan.stdout, scan.returncode, diagnostics=scan.stderr)
        if disposition_count:
            print('TruffleHog passed: one exact historical synthetic Postgres test fixture disposition.')
        else:
            print('TruffleHog passed: no findings.')
    except (KeyError, OSError, json.JSONDecodeError, ValueError) as exc:
        print(f'TruffleHog gate failed: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
