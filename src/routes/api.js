import { Router } from 'express';
import { loginSession, logoutSession, requireAdminSession, requireAppSession } from '../modules/sessionAuthService.js';
import { listFavorites, addFavorite, removeFavorite, clearFavorites } from '../modules/favoritesService.js';
import { clearChannelCache, findChannel, getChannels } from '../modules/playlistService.js';
import { getPlaybackInfo } from '../modules/playbackService.js';
import {
  clearActivePlaylistSource,
  deleteActiveWebScanChannel,
  deletePlaylistSource,
  getSourceStatus,
  savePlaylistSource,
  savePlaylistSources,
  saveUploadedPlaylistSource,
  setActivePlaylistSource,
} from '../modules/sourceStorage.js';
import { parseUploadedPlaylist } from '../modules/uploadedPlaylistParser.js';
import { proxyStream } from '../modules/streamProxy.js';
import { playUniversal, playHlsResource, playTranscodedResource } from '../modules/universalPlayback.js';
import { getAccountHealth, removeAccountHealth, scanAccount, scanAccounts } from '../modules/accountHealthService.js';
import { deleteAccountsByIds } from '../modules/accountBulkDeleteService.js';
import { getAccountAutoScanStatus, reconfigureAccountAutoScanScheduler, stopAccountAutoScanSchedulerForTenant } from '../modules/accountAutoScanScheduler.js';
import { getPersistentFailureStatus } from '../modules/accountFailureTracker.js';
import { getAppSettings, updateAppSettings } from '../modules/appSettingsService.js';
import { createAccessUser, listAccessUsers, revokeAccessUser } from '../modules/userAccessService.js';
import { assignExistingUrlAccountToUser, assignUrlAccountToUser } from '../modules/userAccountAssignmentService.js';
import { deleteWebScanResults, scanWebPage, saveWebScanSelection } from '../modules/webScanService.js';
import {
  deleteFullSiteScanResults,
  getFullSiteScanStatus,
  pauseFullSiteScan,
  resumeFullSiteScan,
  saveFullSiteScanSelection,
  startFullSiteScan,
  stopFullSiteScan,
} from '../modules/fullSiteScanService.js';

export const apiRouter = Router();

function toSafeNumber(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function createChannelMatcher(query, favoriteIds) {
  const favoriteSet = new Set(favoriteIds);
  const search = String(query.q || '').trim().toLocaleLowerCase('tr-TR');
  const group = String(query.group || 'Tumu');
  const type = String(query.type || 'all');
  const favoritesOnly = String(query.favorites || '') === '1';

  return {
    favoriteSet,
    matches(channel) {
      const groupMatches = group === 'Tumu' || channel.group === group;
      const typeMatches = type === 'all' || channel.type === type;
      const favoriteMatches = !favoritesOnly || favoriteSet.has(channel.id);
      const searchMatches = !search || channel.name.toLocaleLowerCase('tr-TR').includes(search);
      return groupMatches && typeMatches && favoriteMatches && searchMatches;
    },
  };
}

function selectChannelPage(channels, query, favoriteIds, offset, limit) {
  const { favoriteSet, matches } = createChannelMatcher(query, favoriteIds);
  const page = [];
  let total = 0;

  for (const channel of channels) {
    if (!matches(channel)) continue;

    if (total >= offset && page.length < limit) {
      page.push({
        ...channel,
        favorite: favoriteSet.has(channel.id),
      });
    }

    total += 1;
  }

  return { page, total };
}

apiRouter.get('/health', (req, res) => {
  res.json({ ok: true, name: 'Siberdeyz IPTV Player' });
});

apiRouter.post('/admin/login', loginSession);
apiRouter.post('/admin/logout', logoutSession);

apiRouter.use(requireAppSession);

apiRouter.get('/admin/users', requireAdminSession, async (req, res, next) => {
  try {
    res.json(await listAccessUsers());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/admin/users', requireAdminSession, async (req, res, next) => {
  try {
    res.status(201).json(await createAccessUser(req.body?.label));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/admin/users/:id/source', requireAdminSession, async (req, res, next) => {
  try {
    res.status(201).json(await assignUrlAccountToUser(
      req.params.id,
      req.body?.url,
      req.body?.label
    ));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/admin/users/:id/source-copy', requireAdminSession, async (req, res, next) => {
  try {
    res.status(201).json(await assignExistingUrlAccountToUser(
      req.params.id,
      req.body?.sourceId
    ));
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/admin/users/:id', requireAdminSession, async (req, res, next) => {
  try {
    const result = await revokeAccessUser(req.params.id);
    stopAccountAutoScanSchedulerForTenant(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/settings', async (req, res, next) => {
  try {
    res.json(await getAppSettings());
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/settings', async (req, res, next) => {
  try {
    const settings = await updateAppSettings(req.body || {});
    await reconfigureAccountAutoScanScheduler();
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/settings/cache/clear', async (req, res, next) => {
  try {
    clearChannelCache();
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/web-scan', async (req, res, next) => {
  try {
    res.json(await scanWebPage(req.body?.url));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/web-scan/:scanId/save', async (req, res, next) => {
  try {
    const result = await saveWebScanSelection(
      req.params.scanId,
      req.body?.ids,
      req.body?.label
    );
    clearChannelCache();
    await clearFavorites();
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/web-scan/:scanId/results', async (req, res, next) => {
  try {
    res.json(await deleteWebScanResults(req.params.scanId));
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/web-scan/channel/:id', async (req, res, next) => {
  try {
    const result = await deleteActiveWebScanChannel(req.params.id);
    clearChannelCache();
    await clearFavorites();

    if (result.sourceRemoved) {
      await removeAccountHealth(result.sourceId);
    }

    res.json(result);
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/full-site-scan/start', async (req, res, next) => {
  try {
    res.status(202).json(await startFullSiteScan(req.body?.url, req.body?.limit));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/full-site-scan/status', async (req, res, next) => {
  try {
    res.json(await getFullSiteScanStatus());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/full-site-scan/pause', async (req, res, next) => {
  try {
    res.json(await pauseFullSiteScan());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/full-site-scan/resume', async (req, res, next) => {
  try {
    res.json(await resumeFullSiteScan());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/full-site-scan/stop', async (req, res, next) => {
  try {
    res.json(await stopFullSiteScan());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/full-site-scan/:jobId/save', async (req, res, next) => {
  try {
    const result = await saveFullSiteScanSelection(
      req.params.jobId,
      req.body?.ids,
      req.body?.label
    );
    clearChannelCache();
    await clearFavorites();
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/full-site-scan/:jobId/results', async (req, res, next) => {
  try {
    res.json(await deleteFullSiteScanResults(req.params.jobId));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/source', async (req, res, next) => {
  try {
    res.json(await getSourceStatus());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/source/active/reset', async (req, res, next) => {
  try {
    const status = await clearActivePlaylistSource();
    clearChannelCache();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/account-health', async (req, res, next) => {
  try {
    res.json(await getAccountHealth());
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/account-auto-scan', async (req, res, next) => {
  try {
    res.json(await getAccountAutoScanStatus());
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/account-failures', async (req, res, next) => {
  try {
    res.json(await getPersistentFailureStatus());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/account-health/:id/scan', async (req, res, next) => {
  try {
    res.json(await scanAccount(req.params.id));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/account-health/scan', async (req, res, next) => {
  try {
    res.json(await scanAccounts(req.body?.ids));
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/source', async (req, res, next) => {
  try {
    const status = await savePlaylistSource(req.body?.url, req.body?.label);
    clearChannelCache();
    await clearFavorites();
    res.status(201).json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/source/file', async (req, res, next) => {
  try {
    const parsed = parseUploadedPlaylist(req.body?.content, req.body?.fileName);
    const status = parsed.kind === 'sources'
      ? await savePlaylistSources(parsed.sources)
      : await saveUploadedPlaylistSource({
        label: req.body?.label,
        fileName: req.body?.fileName,
        channels: parsed.channels,
      });

    clearChannelCache();
    await clearFavorites();
    res.status(201).json({
      ...status,
      imported: parsed.total,
      importedSources: parsed.kind === 'sources' ? parsed.total : 0,
      importedChannels: parsed.kind === 'channels' ? parsed.total : 0,
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.put('/source/:id/active', async (req, res, next) => {
  try {
    const status = await setActivePlaylistSource(req.params.id);
    clearChannelCache();
    await clearFavorites();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/source/bulk-delete', async (req, res, next) => {
  try {
    const status = await deleteAccountsByIds(req.body?.ids);
    clearChannelCache();
    await clearFavorites();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/source/:id', async (req, res, next) => {
  try {
    const status = await deletePlaylistSource(req.params.id);
    await removeAccountHealth(req.params.id);
    clearChannelCache();
    await clearFavorites();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/source', async (req, res, next) => {
  try {
    const status = await deletePlaylistSource();
    await removeAccountHealth();
    clearChannelCache();
    await clearFavorites();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/favorites', async (req, res, next) => {
  try {
    res.json(await listFavorites());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/favorites/:id', async (req, res, next) => {
  try {
    res.status(201).json(await addFavorite(req.params.id));
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/favorites/:id', async (req, res, next) => {
  try {
    res.json(await removeFavorite(req.params.id));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/channels', async (req, res, next) => {
  try {
    const offset = toSafeNumber(req.query.offset, 0, 1000000);
    const limit = toSafeNumber(req.query.limit, 100, 300);
    const result = await getChannels({ force: req.query.refresh === '1' });
    const { ids: favoriteIds } = await listFavorites();

    if (!result.sourceReady) {
      res.json({ ...result, groups: ['Tumu'], total: 0, offset, limit, hasMore: false });
      return;
    }

    const { page, total } = selectChannelPage(result.channels, req.query, favoriteIds, offset, limit);

    res.json({
      channels: page,
      sourceReady: true,
      cached: result.cached,
      stale: result.stale,
      groups: result.groups || ['Tumu'],
      types: { all: 'Tumu', live: 'Canli TV', movie: 'Film', series: 'Dizi' },
      total,
      allTotal: result.channels.length,
      offset,
      limit,
      hasMore: offset + page.length < total,
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/playback/:id', async (req, res, next) => {
  try {
    const channel = await findChannel(req.params.id);
    if (!channel) {
      res.status(404).json({ error: 'Yayin bulunamadi' });
      return;
    }
    res.json(getPlaybackInfo(channel));
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/play/:id', async (req, res, next) => {
  try {
    await playUniversal(req, res);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/media/hls/:token', async (req, res, next) => {
  try {
    await playHlsResource(req, res);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/media/transcode/:session/:file', async (req, res, next) => {
  try {
    await playTranscodedResource(req, res);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/stream/:id', async (req, res, next) => {
  try {
    await proxyStream(req, res);
  } catch (error) {
    next(error);
  }
});
