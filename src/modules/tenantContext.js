import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';

const tenantStorage = new AsyncLocalStorage();
const rootDataDir = path.join(process.cwd(), 'data');

function safeTenantId(value) {
  const id = String(value || 'admin').trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : 'admin';
}

export function getTenantIdentity() {
  return tenantStorage.getStore() || {
    tenantId: 'admin',
    role: 'admin',
    userId: 'admin',
  };
}

export function getTenantId() {
  return safeTenantId(getTenantIdentity().tenantId);
}

export function getTenantDataDir() {
  const tenantId = getTenantId();
  return tenantId === 'admin'
    ? rootDataDir
    : path.join(rootDataDir, 'users', tenantId);
}

export function runWithTenant(identity, callback) {
  const tenantId = safeTenantId(identity?.tenantId || identity?.userId || 'admin');
  const role = identity?.role === 'user' ? 'user' : 'admin';

  return tenantStorage.run({
    tenantId,
    role,
    userId: tenantId === 'admin' ? 'admin' : tenantId,
  }, callback);
}

export function runWithTenantId(tenantId, callback) {
  const safeId = safeTenantId(tenantId);
  return runWithTenant({
    tenantId: safeId,
    userId: safeId,
    role: safeId === 'admin' ? 'admin' : 'user',
  }, callback);
}
