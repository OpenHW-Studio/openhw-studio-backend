export const requireRole = (...allowedRoles) => {
  const normalized = new Set(
    allowedRoles
      .flat()
      .map((role) => String(role || '').trim().toLowerCase())
      .filter(Boolean)
  );

  return (req, res, next) => {
    const role = String(req.user?.role || '').trim().toLowerCase();
    if (!role || !normalized.has(role)) {
      return res.status(403).json({ message: 'Access denied: insufficient permissions' });
    }
    return next();
  };
};

export const requireAdmin = requireRole('admin');
