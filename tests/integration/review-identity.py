"""Read-only hosted acceptance of GitHub App identity binding; never invokes a model."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runtime.review.github import GitHub, PublisherMismatch


def main():
    token = os.environ['REVIEW_IDENTITY_TOKEN']
    client = GitHub(os.environ['REVIEW_IDENTITY_REPOSITORY'], token)
    identity = {'id': 41898282, 'login': 'github-actions[bot]'}
    client.assert_publisher(identity)
    try:
        client.assert_publisher({**identity, 'id': 0})
    except PublisherMismatch:
        print('Authenticated GitHub identity accepted; mismatched identity rejected. No writes.')
        return
    raise RuntimeError('Mismatched identity was accepted')


if __name__ == '__main__':
    main()
