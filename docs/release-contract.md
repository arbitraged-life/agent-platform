# Release contract v1

Build from a clean committed checkout:

```sh
python3 scripts/platform-release.py build --output /tmp/agent-platform.tar > /tmp/agent-platform.lock.json
```

The uncompressed tar has sorted paths, fixed timestamps, normalized permissions,
and a manifest of file hashes. Repeated builds of a commit produce identical
bytes. The lock contains schema_version, commit, sha256, and artifact filename.
The consuming repository stores this lock and obtains the named release asset
from a trusted distribution channel.

```sh
python3 scripts/platform-release.py install --bundle /tmp/agent-platform.tar --lock /tmp/agent-platform.lock.json --destination /tmp/platform-installations
```

Installation checks the bundle digest, paths, entry types, sizes, source commit,
and every file hash before atomically installing a versioned directory. Existing
versions are immutable; installation never changes an active service or symlink.
Consumers choose a verified version explicitly and retain the previous version
for rollback. Bootstrap the installer from an independently pinned source commit;
never execute an installer extracted from an unverified download.

Reusable workflows are consumed at a full commit SHA. Account-specific triggers,
reviewer policies, destinations, allowlists, and secret references remain in the
consumer. No environment-specific configuration is shipped inside the bundle.
