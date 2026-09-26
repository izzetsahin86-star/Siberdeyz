import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { apiRouter } from './routes/api.js';
import { startAccountAutoScanScheduler } from './modules/accountAutoScanScheduler.js';
import { startMemoryMonitor } from './modules/memoryMonitor.js';

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
  startMemoryMonitor();

  startAccountAutoScanScheduler().catch((error) => {
    console.error('Automatic account scanner could not start:', error);
  });
});
