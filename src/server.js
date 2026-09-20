import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { apiRouter } from './routes/api.js';
import { startAccountAutoScanScheduler } from './modules/accountAutoScanScheduler.js';
import { getPlaylistSourceById } from './modules/sourceStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(publicDir));
app.use('/api', apiRouter);

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) {
    next(error);
    return;
  }
  const status = Number(error.status || error.statusCode) || 500;
  res.status(status).json({ error: error.message || 'Beklenmeyen hata' });
});

app.listen(config.port, () => {
  console.log(`Siberdeyz IPTV Player listening on ${config.port}`);

  startAccountAutoScanScheduler().catch((error) => {
    console.error('Automatic account scanner could not start:', error);
  });

  getPlaylistSourceById('m3u_yayinlarim')
    .then((source) => {
      if (!source) return;
      const rows = (source.channels || []).map((channel) => {
        let mediaId = '';
        try {
          const base = new URL(String(channel.url || '')).pathname.split('/').pop() || '';
          mediaId = base.match(/\d{6,20}/)?.[0] || '';
        } catch {}
        return {
          id: String(channel.id || ''),
          name: String(channel.name || ''),
          mediaId,
          hasPageUrl: Boolean(String(channel.pageUrl || '').trim()),
        };
      });
      console.log('MAILRU_LEGACY_IDENTITIES ' + JSON.stringify(rows));
    })
    .catch((error) => console.error('MAILRU_LEGACY_IDENTITIES_ERROR', error?.message || error));
});
