"""Read-only hosted acceptance of GitHub App identity binding; never invokes a model."""
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from runtime.review.github import GitHub
from runtime.review.transport import request


def main():
    token = os.environ['REVIEW_IDENTITY_TOKEN']
    response = request('https://api.github.com/graphql', token,
                       {'query': 'query { viewer { login databaseId } }'})
    viewer = response['data']['viewer']
    client = GitHub(os.environ['REVIEW_IDENTITY_REPOSITORY'], token)
    identity = {'id': viewer['databaseId'], 'login': viewer['login']}
    client.assert_publisher(identity)
    try:
        client.assert_publisher({**identity, 'id': 0})
    except ValueError:
        print('Authenticated GitHub identity accepted; mismatched identity rejected. No writes.')
        return
    raise RuntimeError('Mismatched identity was accepted')


if __name__ == '__main__':
    main()
