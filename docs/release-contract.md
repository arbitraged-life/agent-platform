# Release contract v1

Build from a clean committed checkout:

```sh
python3 scripts/platform-release.py build --output /tmp/agent-platform.tar > /tmp/agent-platform.lock.json
```

The uncompressed tar has sorted paths, fixed timestamps, normalized tracked executable permissions (0755 or 0644),
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

Build and install share a 64 MiB size ceiling and 10,000-entry ceiling. Oversized builds fail before returning a release lock or replacing an existing artifact. Paths containing colons are rejected during installation for cross-platform extraction safety.

Builds stream committed Git archive entries, enforce entry and expanded-byte bounds before reading each body, and terminate the archive producer on rejection. Published bundle files use mode 0644; executable entry permissions come from committed Git modes.
