import { deletePlaylistSource, getSourceStatus } from './sourceStorage.js';
import { removeAccountHealth } from './accountHealthService.js';
import { removeAccountFavorites } from './accountFavoritesService.js';

const MAX_BATCH_DELETE = 100;

export async function deleteAccountsByIds(sourceIds = []) {
  const ids = Array.from(new Set(
    (Array.isArray(sourceIds) ? sourceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )).slice(0, MAX_BATCH_DELETE);

  if (ids.length === 0) {
    return {
      deleted: 0,
      ...(await getSourceStatus()),
    };
  }

  for (const id of ids) {
    await deletePlaylistSource(id);
    await removeAccountHealth(id);
  }
  await removeAccountFavorites(ids);

  return {
    deleted: ids.length,
    ...(await getSourceStatus()),
  };
}
