const DEFAULT_CACHE_SECONDS = 120;

export const config = {
  port: Number(process.env.PORT || 3000),
  cacheSeconds: Number(process.env.PLAYLIST_CACHE_SECONDS || DEFAULT_CACHE_SECONDS),
  adminPassword: String(process.env.ADMIN_PASSWORD || '').trim(),\n  sessionSecret: String(process.env.SESSION_SECRET || '').trim(),\n  nodeEnv: String(process.env.NODE_ENV || 'development'),
};
