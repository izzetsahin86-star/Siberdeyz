import { Router } from 'express';
import { isAdminPassword, requireAdmin } from '../modules/authService.js';
import { listFavorites, addFavorite, removeFavorite, clearFavorites } from '../modules/favoritesService.js';
import { clearChannelCache, findChannel, getChannels } from '../modules/playlistService.js';
import { getPlaybackInfo } from '../modules/playbackService.js';
import { deletePlaylistSource, getSourceStatus, savePlaylistSource } from '../modules/sourceStorage.js';
import { proxyStream } from '../modules/streamProxy.js';

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

apiRouter.post('/admin/login', (req, res) => {
  if (!isAdminPassword(req.body?.adminPassword)) {
    res.status(401).json({ error: 'Admin sifresi hatali.' });
    return;
  }

  res.json({ ok: true });
});

apiRouter.get('/source', async (req, res, next) => {
  try {
    res.json(await getSourceStatus());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/source', requireAdmin, async (req, res, next) => {
  try {
    const status = await savePlaylistSource(req.body?.url);
    clearChannelCache();
    await clearFavorites();
    res.status(201).json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/source', requireAdmin, async (req, res, next) => {
  try {
    const status = await deletePlaylistSource();
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

apiRouter.get('/stream/:id', async (req, res, next) => {
  try {
    await proxyStream(req, res);
  } catch (error) {
    next(error);
  }
});
