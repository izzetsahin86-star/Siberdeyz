import { config, hasPlaylistSource } from '../config.js';
import { parseM3U } from './m3uParser.js';

let cache = {
  loadedAt: 0,
  channels: [],
};

function isCacheFresh() {
  const ageMs = Date.now() - cache.loadedAt;
  return cache.channels.length > 0 && ageMs < config.cacheSeconds * 1000;
}

export async function getChannels({ force = false } = {}) {
  if (!hasPlaylistSource()) {
    return { channels: [], sourceReady: false, cached: false };
  }

  if (!force && isCacheFresh()) {
    return { channels: cache.channels, sourceReady: true, cached: true };
  }

  const response = await fetch(config.playlistUrl, {
    headers: {
      'user-agent': 'Siberdeyz-IPTV-Player/1.0',
      accept: 'application/x-mpegURL,text/plain,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Yayin listesi alinamadi: HTTP ${response.status}`);
  }

  const text = await response.text();
  const channels = parseM3U(text);

  cache = {
    loadedAt: Date.now(),
    channels,
  };

  return { channels, sourceReady: true, cached: false };
}

export async function findChannel(channelId) {
  const { channels } = await getChannels();
  return channels.find((channel) => channel.id === String(channelId));
}
