#!/usr/bin/env bash
set -uo pipefail
DEST="$1"
mkdir -p "$DEST"
cat > "$DEST/lib.js" <<'JS'
function canAccessProjectResource(user, project) {
  // BUG: checks the user's ORG-level role instead of a PROJECT-level role,
  // so any org member/admin gets access to every project's resources.
  const orgRole = user.orgRoles && user.orgRoles[project.orgId];
  return orgRole === 'member' || orgRole === 'admin';
}

module.exports = { canAccessProjectResource };
JS
