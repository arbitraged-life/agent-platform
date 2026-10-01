const assert = require('assert');
const path = require('path');
const { canAccessProjectResource } = require(path.join(process.argv[2], 'lib.js'));

const project1 = { id: 'proj-1', orgId: 'org-1' };
const project2 = { id: 'proj-2', orgId: 'org-1' };

// org admin, but no project-level role at all -> must be denied
const orgAdminNoProjectRole = { orgRoles: { 'org-1': 'admin' }, projectRoles: {} };
assert.strictEqual(
  canAccessProjectResource(orgAdminNoProjectRole, project1),
  false,
  'org-level admin with no project role must be denied project access'
);

// no org role at all, but has an explicit project role -> must be granted
const projectMemberNoOrgRole = { orgRoles: {}, projectRoles: { 'proj-1': 'member' } };
assert.strictEqual(
  canAccessProjectResource(projectMemberNoOrgRole, project1),
  true,
  'a user with only a project-level role must be granted access to that project'
);

// project role for a DIFFERENT project must not grant access to project1
const wrongProjectRole = { orgRoles: {}, projectRoles: { 'proj-2': 'admin' } };
assert.strictEqual(
  canAccessProjectResource(wrongProjectRole, project1),
  false,
  'a role scoped to a different project must not grant access'
);
void project2;

console.log('OK: access is gated on the correct project-scoped role');
