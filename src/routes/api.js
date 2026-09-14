import { Router } from 'express';
import { clearChannelCache, getChannels } from '../modules/playlistService.js';
import { deletePlaylistSource, getSourceStatus, savePlaylistSource } from '../modules/sourceStorage.js';
import { proxyStream } from '../modules/streamProxy.js';

export const apiRouter = Router();

function toSafeNumber(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(Math.floor(number), max);
}

function filterChannels(channels, query) {
  const search = String(query.q || '').trim().toLocaleLowerCase('tr-TR');
  const group = String(query.group || 'Tumu');

  return channels.filter((channel) => {
    const groupMatches = group === 'Tumu' || channel.group === group;
    const searchMatches = !search || channel.name.toLocaleLowerCase('tr-TR').includes(search);
    return groupMatches && searchMatches;
  });
}

apiRouter.get('/health', (req, res) => {
  res.json({ ok: true, name: 'Siberdeyz IPTV Player' });
});

apiRouter.get('/source', async (req, res, next) => {
  try {
    res.json(await getSourceStatus());
  } catch (error) {
    next(error);
  }
});

apiRouter.post('/source', async (req, res, next) => {
  try {
    const status = await savePlaylistSource(req.body?.url);
    clearChannelCache();
    res.status(201).json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.delete('/source', async (req, res, next) => {
  try {
    const status = await deletePlaylistSource();
    clearChannelCache();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

apiRouter.get('/channels', async (req, res, next) => {
  try {
    const offset = toSafeNumber(req.query.offset, 0, 1000000);
    const limit = toSafeNumber(req.query.limit, 100, 300);
    const result = await getChannels({ force: req.query.refresh === '1' });

    if (!result.sourceReady) {
      res.json({ ...result, groups: ['Tumu'], total: 0, offset, limit, hasMore: false });
      return;
    }

    const groups = ['Tumu', ...new Set(result.channels.map((channel) => channel.group).sort())];
    const filtered = filterChannels(result.channels, req.query);
    const page = filtered.slice(offset, offset + limit);

    res.json({
      channels: page,
      sourceReady: true,
      cached: result.cached,
      groups,
      total: filtered.length,
      allTotal: result.channels.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
    });
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
