function canAccessProjectResource(user, project) {
  const role = user.projectRoles && user.projectRoles[project.id];
  return role === 'member' || role === 'admin';
}

module.exports = { canAccessProjectResource };
