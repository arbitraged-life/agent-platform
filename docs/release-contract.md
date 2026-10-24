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
The CLI requires a separately trusted SHA-256 pin of the **lock file itself**;
a lock and bundle chosen together by an untrusted agent are not an authenticated
release. An independently reviewed consuming repository or an approved release
manifest must supply that digest. Canonicalized parent-path aliases (including
system `/tmp` symlinks) are accepted only after the lock content pin matches.

```sh
# EXPECTED_LOCK_SHA256 must be copied from independently reviewed and pinned
# consumer configuration; do not calculate it from an untrusted lock at runtime.
python3 scripts/platform-release.py install --bundle /tmp/agent-platform.tar --lock /tmp/agent-platform.lock.json --expected-lock-sha256 "$EXPECTED_LOCK_SHA256" --destination /tmp/platform-installations --directory-mode 0755
```

Installation checks the bundle digest, paths, entry types, sizes, source commit,
and every file hash before atomically installing a versioned directory. On Linux
and macOS, publication uses an OS-provided atomic **no-replace** rename and fails
closed if the primitive is unavailable. Existing versions are immutable;
installation never changes an active service or symlink. Consumers choose a
verified version explicitly and retain the previous version for rollback.

Install and verify use pinned directory descriptors and rewalk every destination
ancestor without following symlinks before acceptance. CLI callers retain the
descriptor captured during destination validation, rather than reopening a
potentially replaced path. Installation roots must not be group/world writable;
new install roots use a caller-selected mode: 0700 by default, or 0750 or
0755 for cross-account consumers, under a restrictive umask; temporary staging
remains private (0700) through validation, then adopts the selected consumer
mode immediately before atomic publication. The release path depth
is limited to 32 components to bound descriptors during readback. Archives and
installed files are read with explicit size bounds; directory enumeration
is incremental. Cleanup failures are reported, including the staging name.

These checks detect many concurrent renames and changes; they do not provide
an immutable filesystem snapshot or protect against an attacker who can rename
trusted ancestors using the same privileges as the installer. Consumers must
control their install roots and filesystem writers independently.

Installation and independent permission readback require POSIX filesystem
mode semantics (Linux/macOS). Windows installation and verification explicitly
fail rather than misrepresenting POSIX executable permissions.

Bootstrap the installer from an independently pinned source commit; never
execute an installer extracted from an unverified download.

Reusable workflows are consumed at a full commit SHA. Account-specific triggers,
reviewer policies, destinations, allowlists, and secret references remain in the
consumer. No environment-specific configuration is shipped inside the bundle.

Build and install share a 64 MiB size ceiling and 10,000-entry ceiling. Oversized builds fail before returning a release lock or replacing an existing artifact. Paths containing colons are rejected during installation for cross-platform extraction safety.

Builds stream committed Git archive entries, enforce entry and expanded-byte bounds before reading each body, and terminate the archive producer on rejection. Published bundle files use mode 0644; executable entry permissions come from committed Git modes.

## Independent installed-byte acceptance

After a consumer explicitly installs a pinned release, verify the original
trusted artifact and the installed content independently:

```sh
python3 scripts/platform-release.py verify --bundle /tmp/agent-platform.tar --lock /tmp/agent-platform.lock.json --expected-lock-sha256 "$EXPECTED_LOCK_SHA256" --destination /tmp/platform-installations
```

This read-only command validates the lock and artifact digest, archive manifest,
installed file inventory and hashes, and reports a source commit, release digest
and `installed-bytes-verified` state. Verification checks exact installed file
sizes, all permission bits, and bounded SHA-256 reads before issuing that
receipt. The Python API verifies byte consistency against a **caller-supplied**
lock; it cannot independently authenticate that lock's origin. The receipt's
`lock_origin_authenticated` is explicitly unknown. CLI users must independently
pin the lock digest and Python callers must enforce an equivalent source of
trust. Verification is a point-in-time readback, not a guarantee against
concurrent or subsequent changes by another process.
The command-line `install` and `verify` entry points require the bundle and
trusted lock to be co-located, with the exact lock-declared artifact basename.
Their `--destination` must resolve to a subdirectory of that independently
pinned artifact directory. This bounds agent-supplied CLI paths and rejects
traversal and symlink redirection outside the chosen release staging root.
For a different install root, place the pinned artifact and lock in a trusted
staging directory within that root before invoking the CLI.
They reject symlinks and `..` components to prevent a compromised tool caller
from redirecting a release-artifact read outside the intended lock directory.
Python API callers retain responsibility for enforcing their own trusted
bundle directory before calling `install` or `verify_installation` directly.
Verification fails closed on missing, modified, additional, symlinked, or
otherwise unsupported installed files.

**No deployment or runtime acceptance is inferred.** The consumer must separately
prove that the verified version was selected, deployed, and actually exercised
under its intended permissions. Do not auto-upgrade a consumer on this evidence.
