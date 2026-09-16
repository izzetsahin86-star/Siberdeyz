import { accessUserExists } from './userAccessService.js';
import { runWithTenantId } from './tenantContext.js';
import { getPlaylistSourceById, savePlaylistSource } from './sourceStorage.js';

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
    return {
      ok: true,
      userId: id,
      sourceCount: Array.isArray(status.sources) ? status.sources.length : 0,
    };
  });
}


export async function assignExistingUrlAccountToUser(userId, sourceId) {
  const id = String(userId || '').trim();

  if (!id || !(await accessUserExists(id))) {
    const error = new Error('Kullanici bulunamadi.');
    error.status = 404;
    throw error;
  }

  const source = await getPlaylistSourceById(sourceId);

  if (!source) {
    const error = new Error('Aktarilacak hesap bulunamadi.');
    error.status = 404;
    throw error;
  }

  if (source.type !== 'url' || !source.url) {
    const error = new Error('Yalnizca URL hesaplari kullaniciya aktarilabilir.');
    error.status = 400;
    throw error;
  }

  return runWithTenantId(id, async () => {
    const status = await savePlaylistSource(source.url, source.label || '', { activate: false });

    return {
      ok: true,
      userId: id,
      sourceCount: Array.isArray(status.sources) ? status.sources.length : 0,
      transferredLabel: source.label || '',
    };
  });
}
