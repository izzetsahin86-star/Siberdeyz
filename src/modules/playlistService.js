import { config } from '../config.js';
import { enrichChannel } from './channelClassifier.js';
import { parseM3U, parseM3UStream } from './m3uParser.js';
import { getPlaylistSource } from './sourceStorage.js';

let cache = {
  loadedAt: 0,
  sourceUrl: '',
  channels: [],
  groups: ['Tumu'],
};

let pendingLoad = null;
let pendingSourceUrl = '';

function hasUsableCache(sourceUrl) {
  return cache.sourceUrl === sourceUrl && cache.channels.length > 0;
}

function isCacheFresh(sourceUrl) {
  const ageMs = Date.now() - cache.loadedAt;
  return hasUsableCache(sourceUrl) && ageMs < config.cacheSeconds * 1000;
}

function buildGroups(channels) {
  return ['Tumu', ...new Set(channels.map((channel) => channel.group).sort((a, b) => a.localeCompare(b, 'tr')))];
}

function readPlaylist(response) {
  if (response.body?.getReader) {
    return parseM3UStream(response.body, enrichChannel);
  }

  return response.text().then((text) => parseM3U(text, enrichChannel));
}

async function loadChannelsFromSource(sourceUrl) {
  const response = await fetch(sourceUrl, {
    headers: {
      'user-agent': 'Siberdeyz-IPTV-Player/1.0',
      accept: 'application/x-mpegURL,text/plain,*/*',
    },
  });

  if (!response.ok) {
    throw new Error(`Yayin listesi alinamadi: HTTP ${response.status}`);
  }

  const channels = await readPlaylist(response);
  const groups = buildGroups(channels);

  cache = {
    loadedAt: Date.now(),
    sourceUrl,
    channels,
    groups,
  };

  return { channels, groups, sourceReady: true, cached: false, stale: false };
}

export function clearChannelCache() {
  cache = {
    loadedAt: 0,
    sourceUrl: '',
    channels: [],
    groups: ['Tumu'],
  };
  pendingLoad = null;
  pendingSourceUrl = '';
}

export async function getChannels({ force = false } = {}) {
  const sourceUrl = await getPlaylistSource();

  if (!sourceUrl) {
    clearChannelCache();
    return { channels: [], groups: ['Tumu'], sourceReady: false, cached: false, stale: false };
  }

  if (!force && hasUsableCache(sourceUrl)) {
    return {
      channels: cache.channels,
      groups: cache.groups,
      sourceReady: true,
      cached: true,
      stale: !isCacheFresh(sourceUrl),
    };
  }

  if (!force && pendingLoad && pendingSourceUrl === sourceUrl) {
    return pendingLoad;
  }

  pendingSourceUrl = sourceUrl;
  pendingLoad = loadChannelsFromSource(sourceUrl).finally(() => {
    pendingLoad = null;
    pendingSourceUrl = '';
  });

  return pendingLoad;
}

export async function findChannel(channelId) {
  const sourceUrl = await getPlaylistSource();

  if (!sourceUrl) return null;

  if (hasUsableCache(sourceUrl)) {
    return cache.channels.find((channel) => channel.id === String(channelId));
  }

  const { channels } = await getChannels();
  return channels.find((channel) => channel.id === String(channelId));
}
