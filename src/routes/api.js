import { Router } from 'express';
import { clearChannelCache, getChannels } from '../modules/playlistService.js';
import { deletePlaylistSource, getSourceStatus, savePlaylistSource } from '../modules/sourceStorage.js';
import { proxyStream } from '../modules/streamProxy.js';

export const apiRouter = Router();

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
    const result = await getChannels({ force: req.query.refresh === '1' });
    res.json(result);
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
