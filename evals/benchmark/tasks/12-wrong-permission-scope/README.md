Bug: the authorization check read `user.orgRoles[project.orgId]` — an
org-scoped role — when the resource actually required a project-scoped role,
so any org member/admin could reach every project under that org regardless
of whether they'd ever been added to the specific project. Correct fix reads
`user.projectRoles[project.id]` instead. The probe includes a user with an
org role but zero project roles (must be denied) and, conversely, a user
with *only* a project role and no org role (must be granted), plus a role
scoped to a different project (must still be denied) — catching a plausible
near-miss that requires *both* an org role and a project role instead of the
project role alone.
