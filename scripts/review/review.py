#!/usr/bin/env python3
"""Validate policy, resolve event context, or review an exact checkout snapshot."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runtime.review.engine import review
from runtime.review.github import GitHub, peer_context, publish
from runtime.review.policy import eligible, validate
from runtime.review.transport import RequestFailure


def read_json(path):
    with Path(path).open('rb') as stream:
        data = stream.read(1_048_577)
    if len(data) > 1_048_576:
        raise ValueError('Input document too large')
    return json.loads(data)


def diff_at(checkout, snapshot):
    with tempfile.TemporaryFile() as stream:
        subprocess.run(['git', '-C', str(checkout), '-c', 'core.quotePath=false',
                        '-c', 'core.hooksPath=/dev/null', 'diff', '--no-ext-diff', '--no-textconv',
                        '--no-renames', '--ignore-submodules=none', '--unified=3',
                        snapshot['base'] + '...' + snapshot['head'], '--'],
                       stdout=stream, stderr=subprocess.DEVNULL, check=True, timeout=60)
        stream.seek(0)
        data = stream.read(16_777_217)
        if len(data) > 16_777_216:
            raise ValueError('Diff exceeds input ceiling')
        return data.decode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['validate', 'context', 'run'])
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--event', type=Path)
    parser.add_argument('--event-name')
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--checkout', type=Path)
    args = parser.parse_args()
    config = validate(read_json(args.config))
    if args.command == 'validate':
        print('Review configuration valid (schema version 1).')
        return 0
    if not args.event or not args.event_name or not args.snapshot:
        parser.error('context/run require --event, --event-name and --snapshot')
    number = eligible(args.event_name, read_json(args.event), config)
    if type(number) is not int or number < 1:
        raise ValueError('Event is not authorized by review policy')
    token = os.environ.get('REVIEW_GITHUB_TOKEN')
    if not token:
        raise ValueError('Review GitHub credential missing')
    client = GitHub(config['repository'], token)
    if args.command == 'context':
        snapshot = client.snapshot(number)
        args.snapshot.write_text(json.dumps(snapshot) + '\n')
        args.snapshot.chmod(0o600)
        output = os.environ.get('GITHUB_OUTPUT')
        if output:
            with Path(output).open('a') as stream:
                stream.write(f'head={snapshot["head"]}\nbase={snapshot["base"]}\nnumber={number}\n')
        print('Authorized review context resolved.')
        return 0
    if not args.checkout:
        parser.error('run requires --checkout')
    snapshot = read_json(args.snapshot)
    if set(snapshot) != {'number', 'base', 'head'} or snapshot['number'] != number:
        raise ValueError('Invalid review snapshot')
    client.assert_current(snapshot)
    diff = diff_at(args.checkout, snapshot)
    peers = peer_context(client, number, config['peer_reviewers'], config['max_peer_chars'])
    result = review(diff, config, peers)
    publication = publish(client, snapshot, result, config)
    print(json.dumps({'status': result['status'], 'findings': len(result['findings']),
                      'reviewed_files': len(result['reviewed_files']), 'omitted_files': len(result['omitted']),
                      'calls': result['calls'], 'publication': publication}))
    return 0 if result['status'] == 'complete' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, RequestFailure):
        # Exception strings may include user paths, credentials or upstream data.
        print('Review failed validation, transport or execution; no clean result is claimed.', file=sys.stderr)
        raise SystemExit(1) from None
