import { recordAccountScanResults, removeAccountFailureRecords } from './accountFailureTracker.js';
import { deleteAutomaticallyFailedSources, getSourceStatus } from './sourceStorage.js';
import { clearChannelCache } from './playlistService.js';

// Called under the health scan queue: a successful manual/automatic scan cannot
// race an older failed scan into deleting a recovered account.
export async function applyAccountScanPolicy(results, sources, options = {}) {
  const currentResults = [];
  const versions = new Map(sources.map(source => [String(source.id), source]));
  const currentSources = new Map((await getSourceStatus()).sources.map(source => [source.id, source]));
  for (const result of results) {
    const scanned = versions.get(result.id);
    const current = scanned && currentSources.get(result.id);
    if (current?.type === 'url' && current.updatedAt === scanned.updatedAt) currentResults.push({ ...result, sourceUpdatedAt: scanned.updatedAt });
  }
  const candidates = await recordAccountScanResults(currentResults, options);
  const deletedIds = candidates.length
    ? await deleteAutomaticallyFailedSources(candidates.map(id => versions.get(id))) : [];
  if (deletedIds.length) {
    await removeAccountFailureRecords(deletedIds);
    clearChannelCache();
  }
  return deletedIds;
}
