import { config } from '../config.js';

export function isAdminPassword(password) {
  return String(password || '') === config.adminPassword;
}

export function requireAdmin(req, res, next) {
  const password = req.get('x-admin-password') || req.body?.adminPassword;

  if (!isAdminPassword(password)) {
    res.status(401).json({ error: 'Admin sifresi hatali veya eksik.' });
    return;
  }

  next();
}
