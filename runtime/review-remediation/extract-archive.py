"""Extract a GitHub source archive without following archive-created links."""
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import sys
import stat
import tarfile


def extract(archive, destination):
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=False)
    root_stat = root.lstat()
    directory_names = {(root_stat.st_dev, root_stat.st_ino): ""}

    def ensure_directories(relative):
        current = root
        names = []
        for part in relative.parts:
            names.append(part)
            current = current / part
            current.mkdir(exist_ok=True)
            info = current.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("non-directory archive parent")
            identity = (info.st_dev, info.st_ino)
            spelling = "/".join(names)
            if identity in directory_names and directory_names[identity] != spelling:
                raise ValueError("aliased archive directory")
            directory_names[identity] = spelling

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
                ensure_directories(relative)
            elif member.isfile():
                total += member.size
                if total > 200 * 1024 * 1024:
                    raise ValueError("archive byte limit")
                ensure_directories(target.parent.relative_to(root))
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
        ensure_directories(target.parent.relative_to(root))
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
