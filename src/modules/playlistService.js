import { config } from '../config.js';
import { enrichChannel } from './channelClassifier.js';
import { parseM3U, parseM3UStream } from './m3uParser.js';
import { getActivePlaylistSource } from './sourceStorage.js';
import { getPlaylistFetchCandidates } from './playlistCompatibility.js';

let cache = {
  loadedAt: 0,
  sourceKey: '',
  channels: [],
  groups: ['Tumu'],
};

let pendingLoad = null;
let pendingSourceKey = '';

function getSourceKey(source) {
  if (!source) return '';
  if (source.type === 'file') {
    return [source.id, source.updatedAt || '', source.channels?.length || 0].join(':');
  }

  return source.url || '';
}

function hasUsableCache(sourceKey) {
  return cache.sourceKey === sourceKey && cache.channels.length > 0;
}

function isCacheFresh(sourceKey) {
  const ageMs = Date.now() - cache.loadedAt;
  return hasUsableCache(sourceKey) && ageMs < config.cacheSeconds * 1000;
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

function readStoredPlaylist(source) {
  return (source.channels || []).map((channel, index) => enrichChannel({
    id: String(channel.id || index + 1),
    name: channel.name,
    logo: channel.logo || '',
    group: channel.group || 'Genel',
    tvgId: channel.tvgId || '',
    url: channel.url,
  }));
}

async function loadChannelsFromSource(source) {
  const sourceKey = getSourceKey(source);

  if (source.type === 'file') {
    const channels = readStoredPlaylist(source);
    const groups = buildGroups(channels);

    cache = {
      loadedAt: Date.now(),
      sourceKey,
      channels,
      groups,
    };

    return { channels, groups, sourceReady: true, cached: false, stale: false };
  }

  const candidates = getPlaylistFetchCandidates(source.url);
  let channels = [];
  let lastStatus = 0;
  let lastError = null;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          'user-agent': 'Siberdeyz-IPTV-Player/1.0',
          accept: 'application/x-mpegURL,text/plain,*/*',
        },
      });

      lastStatus = response.status;

      if (!response.ok) {
        continue;
      }

      const parsedChannels = await readPlaylist(response);

      if (parsedChannels.length > 0) {
        channels = parsedChannels;
        break;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (channels.length === 0) {
    if (lastError) throw lastError;
    throw new Error('Yayin listesi alinamadi: HTTP ' + (lastStatus || 502));
  }

  const groups = buildGroups(channels);

  cache = {
    loadedAt: Date.now(),
    sourceKey,
    channels,
    groups,
  };

  return { channels, groups, sourceReady: true, cached: false, stale: false };
}

export function clearChannelCache() {
  cache = {
    loadedAt: 0,
    sourceKey: '',
    channels: [],
    groups: ['Tumu'],
  };
  pendingLoad = null;
  pendingSourceKey = '';
}

export async function getChannels({ force = false } = {}) {
  const source = await getActivePlaylistSource();
  const sourceKey = getSourceKey(source);

  if (!source || !sourceKey) {
    clearChannelCache();
    return { channels: [], groups: ['Tumu'], sourceReady: false, cached: false, stale: false };
  }

  if (!force && hasUsableCache(sourceKey)) {
    return {
      channels: cache.channels,
      groups: cache.groups,
      sourceReady: true,
      cached: true,
      stale: !isCacheFresh(sourceKey),
    };
  }

  if (!force && pendingLoad && pendingSourceKey === sourceKey) {
    return pendingLoad;
  }

  pendingSourceKey = sourceKey;
  pendingLoad = loadChannelsFromSource(source).finally(() => {
    pendingLoad = null;
    pendingSourceKey = '';
  });

  return pendingLoad;
}

export async function findChannel(channelId) {
  const source = await getActivePlaylistSource();
  const sourceKey = getSourceKey(source);

  if (!source || !sourceKey) return null;

  if (hasUsableCache(sourceKey)) {
    return cache.channels.find((channel) => channel.id === String(channelId));
  }

  const { channels } = await getChannels();
  return channels.find((channel) => channel.id === String(channelId));
}
