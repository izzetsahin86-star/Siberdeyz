import { accessUserExists } from './userAccessService.js';
import { runWithTenantId } from './tenantContext.js';
import { clearChannelCache } from './playlistService.js';
import { savePlaylistSource } from './sourceStorage.js';

export async function assignUrlAccountToUser(userId, url, label = '') {
  const id = String(userId || '').trim();

  if (!id || !(await accessUserExists(id))) {
    const error = new Error('Kullanici bulunamadi.');
    error.status = 404;
    throw error;
  }

  const cleanLabel = String(label || '').trim().slice(0, 80);

  return runWithTenantId(id, async () => {
    const status = await savePlaylistSource(url, cleanLabel, { activate: false });
    clearChannelCache();

    return {
      ok: true,
      userId: id,
      sourceCount: Array.isArray(status.sources) ? status.sources.length : 0,
    };
  });
}
