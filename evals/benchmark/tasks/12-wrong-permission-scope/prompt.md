# Ticket: users with only org-level access can reach project resources

`canAccessProjectResource(user, project)` in `lib.js` should require a
*project-level* role (`member` or `admin`) on the specific project. A
security review found it actually checks the user's org-level role, so a
user who belongs to the org but has never been added to the project can
still access the project's resources.

Fix `canAccessProjectResource` to check `user.projectRoles[project.id]`
instead of the org-level role.
