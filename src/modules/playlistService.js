import { config } from '../config.js';
import { enrichChannel } from './channelClassifier.js';
import { parseM3U } from './m3uParser.js';
import { getPlaylistSource } from './sourceStorage.js';

let cache = {
  loadedAt: 0,
  sourceUrl: '',
  channels: [],
};

function isCacheFresh(sourceUrl) {
  const ageMs = Date.now() - cache.loadedAt;
  return cache.sourceUrl === sourceUrl && cache.channels.length > 0 && ageMs < config.cacheSeconds * 1000;
}

export function clearChannelCache() {
  cache = {
    loadedAt: 0,
    sourceUrl: '',
    channels: [],
  };
}

export async function getChannels({ force = false } = {}) {
  const sourceUrl = await getPlaylistSource();

  if (!sourceUrl) {
    clearChannelCache();
    return { channels: [], sourceReady: false, cached: false };
  }

  if (!force && isCacheFresh(sourceUrl)) {
    return { channels: cache.channels, sourceReady: true, cached: true };
  }

  const response = await fetch(sourceUrl, {
    headers: {
      'user-agent': 'Siberdeyz-IPTV-Player/1.0',
      accept: 'application/x-mpegURL,text/plain,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Yayin listesi alinamadi: HTTP ${response.status}`);
  }

  const text = await response.text();
  const channels = parseM3U(text).map(enrichChannel);

  cache = {
    loadedAt: Date.now(),
    sourceUrl,
    channels,
  };

  return { channels, sourceReady: true, cached: false };
}

export async function findChannel(channelId) {
  const { channels } = await getChannels();
  return channels.find((channel) => channel.id === String(channelId));
}
