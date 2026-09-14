const DEFAULT_CACHE_SECONDS = 120;

export const config = {
  port: Number(process.env.PORT || 3000),
  cacheSeconds: Number(process.env.PLAYLIST_CACHE_SECONDS || DEFAULT_CACHE_SECONDS),
  adminPassword: process.env.ADMIN_PASSWORD || '27061987',
};
