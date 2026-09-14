const DEFAULT_CACHE_SECONDS = 120;

export const config = {
  port: Number(process.env.PORT || 3000),
  playlistUrl: process.env.M3U_SOURCE_URL || '',
  cacheSeconds: Number(process.env.PLAYLIST_CACHE_SECONDS || DEFAULT_CACHE_SECONDS),
};

export function hasPlaylistSource() {
  return Boolean(config.playlistUrl.trim());
}
