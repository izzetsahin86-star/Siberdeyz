import { getTenantId } from './tenantContext.js';

// Serialize read/modify/write operations per tenant without blocking other users.
const pending = new Map();
export async function withTenantMutation(area, operation) {
  const key = getTenantId() + ':' + area;
  const previous = pending.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  pending.set(key, task);
  try { return await task; }
  finally { if (pending.get(key) === task) pending.delete(key); }
}
