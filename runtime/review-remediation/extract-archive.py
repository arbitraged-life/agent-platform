"""Extract a GitHub source archive without following archive-created links."""
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import sys
import tarfile


def extract(archive, destination):
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=False)
    links = []
    seen = set()
    total = 0
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            parts = PurePosixPath(member.name).parts
            if not parts or parts[0] == "/" or ".." in parts or "\\" in member.name:
                raise ValueError("unsafe archive path")
            if len(parts) == 1:
                if not member.isdir():
                    raise ValueError("missing archive root")
                continue
            if any(PureWindowsPath(part).drive or ":" in part for part in parts):
                raise ValueError("drive-qualified archive path")
            relative = Path(*parts[1:])
            if str(relative) in seen:
                raise ValueError("duplicate archive path")
            seen.add(str(relative))
            if len(seen) > 50000:
                raise ValueError("archive file limit")
            target = root / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                total += member.size
                if total > 200 * 1024 * 1024:
                    raise ValueError("archive byte limit")
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, target.open("xb") as dst:
                    while chunk := src.read(1024 * 1024):
                        dst.write(chunk)
                target.chmod(0o755 if member.mode & 0o111 else 0o644)
            elif member.issym():
                links.append((target, member.linkname))
            else:
                raise ValueError("archive contains a special file")
    # Reject a link stored beneath another link's archive path before creating any.
    link_paths = {target for target, _ in links}
    for target, _ in links:
        if any(parent in link_paths for parent in target.parents):
            raise ValueError("nested symbolic links")
        # Prepare all parents while there are no links to follow. Filesystem
        # case/normalization aliases then collide with directories, not links.
        target.parent.mkdir(parents=True, exist_ok=True)
    # Targets stay opaque, including outward links: snapshots use lstat/readlink.
    # Links are created last; extraction never follows them. Execution is containerized.
    for target, link in links:
        os.symlink(link, target)


if __name__ == "__main__":
    try:
        extract(sys.argv[1], sys.argv[2])
    except (ValueError, OSError, tarfile.TarError) as exc:
        print(f"Archive rejected: {type(exc).__name__}", file=sys.stderr)
        sys.exit(1)
