#!/usr/bin/env python3
"""Reject new changes to retired source paths without reading file contents."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


def read_policy(path):
    if path.stat().st_size > 262144:
        raise ValueError('Retirement policy exceeds size limit')
    policy = json.loads(path.read_text())
    if not isinstance(policy, dict) or set(policy) != {'schema_version', 'baseline_commit', 'paths'}:
        raise ValueError('Invalid retirement policy fields')
    if type(policy['schema_version']) is not int or policy['schema_version'] != 1:
        raise ValueError('Unsupported retirement policy version')
    if not isinstance(policy['baseline_commit'], str) or not re.fullmatch('[0-9a-f]{40}', policy['baseline_commit']):
        raise ValueError('Retirement baseline must be an immutable commit')
    rows = policy['paths']
    if not isinstance(rows, list) or not rows or len(rows) > 10000:
        raise ValueError('Retired paths must be a nonempty bounded list')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {'path', 'replacement'}:
            raise ValueError('Invalid retired path entry')
        name = row['path']
        if not isinstance(name, str) or not name or any(c in name for c in '\\*?[]\n\r\0'):
            raise ValueError('Invalid retired path')
        relative = PurePosixPath(name)
        if relative.is_absolute() or '..' in relative.parts or str(relative) != name or name in {'.', '.git'}:
            raise ValueError('Retired paths must be normalized repository-relative paths')
        if name in seen:
            raise ValueError('Duplicate retired path')
        seen.add(name)
        replacement = row['replacement']
        if not isinstance(replacement, str) or not replacement.strip() or len(replacement) > 512:
            raise ValueError('Each retired path requires a replacement')
    return policy


def violations(paths, policy):
    return [{'path': path, 'replacement': row['replacement']}
            for path in paths for row in policy['paths']
            if path == row['path'] or path.startswith(row['path'] + '/')]


def git(root, *arguments):
    result = subprocess.run(['git', '-C', str(root), *arguments], check=True,
                            capture_output=True, timeout=30)
    return result.stdout.decode('utf-8')


def check(root, policy):
    names = git(root, 'diff', '--name-only', '--diff-filter=ACMRT', '-z', '--cached', '--')
    return violations([name for name in names.split('\0') if name], policy)


def check_push(root, policy, updates):
    if len(updates) > 1048576:
        raise ValueError('Push reference input exceeds size limit')
    revisions = set()
    for line in updates.splitlines():
        fields = line.split()
        if len(fields) != 4 or any(not re.fullmatch('[0-9a-f]{40}', fields[i]) for i in [1, 3]):
            raise ValueError('Invalid Git pre-push reference input')
        if fields[1] != '0' * 40:
            revisions.add(git(root, 'rev-parse', fields[1] + '^{commit}').strip())
    commits = set()
    for revision in revisions:
        git(root, 'merge-base', '--is-ancestor', policy['baseline_commit'], revision)
        commits.update(git(root, 'rev-list', policy['baseline_commit'] + '..' + revision).splitlines())
        if len(commits) > 10000:
            raise ValueError('Push commit range exceeds size limit')
    findings = []
    for commit in sorted(commits):
        names = git(root, 'diff-tree', '--root', '--no-commit-id', '--first-parent', '-m',
                    '--name-only', '--diff-filter=ACMRT', '-r', '-z', commit, '--')
        for finding in violations([name for name in names.split('\0') if name], policy):
            findings.append({'commit': commit, **finding})
    return findings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--policy', type=Path, required=True)
    parser.add_argument('--pre-push', action='store_true', help='Read Git pre-push reference updates from stdin')
    args = parser.parse_args()
    try:
        policy = read_policy(args.policy)
        findings = (check_push(args.root, policy, sys.stdin.read(1048577))
                    if args.pre_push else check(args.root, policy))
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Retired-path check failed: ' + type(error).__name__, file=sys.stderr)
        return 2
    if findings:
        print(json.dumps({'retired_source_changes': findings}, ensure_ascii=True), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
