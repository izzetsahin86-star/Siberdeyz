import { Router } from 'express';
import { getChannels } from '../modules/playlistService.js';
import { proxyStream } from '../modules/streamProxy.js';

export const apiRouter = Router();

apiRouter.get('/health', (req, res) => {
  res.json({ ok: true, name: 'Siberdeyz IPTV Player' });
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
