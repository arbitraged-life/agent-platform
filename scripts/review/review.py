#!/usr/bin/env python3
"""Validate policy, resolve event context, or review an exact checkout snapshot."""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import time

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


def diff_at(checkout, snapshot, max_bytes=16_777_216):
    executable = shutil.which('git')
    if not executable:
        raise ValueError('Git executable missing')
    command = [executable, '--no-pager', '-C', str(checkout), '-c', 'core.quotePath=false',
               '-c', 'core.hooksPath=' + os.devnull, '-c', 'core.fsmonitor=false',
               'diff', '--no-ext-diff', '--no-textconv', '--text', '--no-renames',
               '--ignore-submodules=none', '--unified=3', snapshot['base'] + '...' + snapshot['head'], '--']
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0) as process:
        data = bytearray()
        deadline = time.monotonic() + 60
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise subprocess.TimeoutExpired(command, 60)
                    chunk = os.read(process.stdout.fileno(), min(65536, max_bytes - len(data) + 1))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > max_bytes:
                        raise ValueError('Diff exceeds input ceiling')
            code = process.wait(timeout=max(0.01, deadline - time.monotonic()))
            if code:
                raise subprocess.CalledProcessError(code, command)
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
        return data.decode('utf-8', errors='surrogateescape')


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
    print(json.dumps({'event': 'review.coverage', 'status': result['status'], 'findings': len(result['findings']),
                      'reviewed_files': len(result['reviewed_files']), 'omitted_files': len(result['omitted']),
                      'calls': result['calls'], 'failures': dict(Counter(row['reason'] for row in result['failures']))}), flush=True)
    try:
        publication = publish(client, snapshot, result, config)
    except RequestFailure as error:
        status = error.status if type(error.status) is int and 100 <= error.status <= 599 else None
        print(json.dumps({'event': 'review.publication', 'status': 'failed', 'http_status': status}), flush=True)
        raise
    except ValueError:
        print(json.dumps({'event': 'review.publication', 'status': 'refused'}), flush=True)
        raise
    print(json.dumps({'event': 'review.publication', 'status': publication}))
    return 0 if result['status'] == 'complete' else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, RequestFailure):
        # Exception strings may include user paths, credentials or upstream data.
        print('Review failed validation, transport or execution; no clean result is claimed.', file=sys.stderr)
        raise SystemExit(1) from None
