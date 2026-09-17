import { Router } from 'express';
import { requireAppSession } from '../modules/sessionAuthService.js';
import { clearFavorites } from '../modules/favoritesService.js';
import { clearChannelCache } from '../modules/playlistService.js';
import {
  deleteMediaSearchResults,
  saveMediaSearchSelection,
  scanMediaBySearch,
} from '../modules/mediaSearchScanService.js';

export const mediaSearchRouter = Router();

mediaSearchRouter.post('/media-search-scan', requireAppSession, async (req, res, next) => {
  try {
    res.json(await scanMediaBySearch({
      url: req.body?.url,
      movie: req.body?.movie,
      actor: req.body?.actor,
    }));
  } catch (error) {
    next(error);
  }
});

mediaSearchRouter.post('/media-search-scan/:scanId/save', requireAppSession, async (req, res, next) => {
  try {
    const result = await saveMediaSearchSelection(
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

mediaSearchRouter.delete('/media-search-scan/:scanId/results', requireAppSession, async (req, res, next) => {
  try {
    res.json(await deleteMediaSearchResults(req.params.scanId));
  } catch (error) {
    next(error);
  }
});
