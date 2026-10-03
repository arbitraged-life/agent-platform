#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  resolve-skill-path.sh --name <skill-name> [--mkdir]

Outputs the canonical SKILL.md path for a new skill in agent-platform.
Use name and description frontmatter. The former scope taxonomy is retired;
repository ownership is the boundary. See skills/ROUTING.md.
USAGE
}

name=""
create_dir="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      name="${2:-}"
      shift 2
      ;;
    --mkdir)
      create_dir="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$name" ]]; then
  echo "--name is required." >&2
  usage >&2
  exit 1
fi

if [[ ! "$name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ || ${#name} -gt 64 ]]; then
  echo "Invalid skill name '$name'. Use kebab-case with at most 64 characters." >&2
  exit 1
fi

path="skills/${name}/SKILL.md"

if [[ "$create_dir" == "true" ]]; then
  mkdir -p "$(dirname "$path")"
fi

printf '%s\n' "$path"
