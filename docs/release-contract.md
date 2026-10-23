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

## Independent installed-byte acceptance

After a consumer explicitly installs a pinned release, verify the original
trusted artifact and the installed content independently:

```sh
python3 scripts/platform-release.py verify --bundle /tmp/agent-platform.tar --lock /tmp/agent-platform.lock.json --destination /tmp/platform-installations
```

This read-only command validates the lock and artifact digest, archive manifest,
installed file inventory and hashes, and reports a source commit, release digest
and `installed-bytes-verified` state. It fails closed on missing, modified,
additional, symlinked or otherwise unsupported installed files.

**No deployment or runtime acceptance is inferred.** The consumer must separately
prove that the verified version was selected, deployed, and actually exercised
under its intended permissions. Do not auto-upgrade a consumer on this evidence.
