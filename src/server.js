import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { apiRouter } from './routes/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const publicDir = path.join(__dirname, '..', 'public');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));
app.use('/api', apiRouter);

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) {
    next(error);
    return;
  }
  res.status(500).json({ error: error.message || 'Beklenmeyen hata' });
});

app.listen(config.port, () => {
  console.log(`Siberdeyz IPTV Player listening on ${config.port}`);
});
