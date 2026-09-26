import { config } from '../config.js';
import { enrichChannel } from './channelClassifier.js';
import { parseM3U, parseM3UStream } from './m3uParser.js';
import { getActivePlaylistSource } from './sourceStorage.js';
import { getPlaylistFetchCandidates } from './playlistCompatibility.js';
import { getTenantId } from './tenantContext.js';

const tenantCaches = new Map();
const MAX_TENANT_CACHES = 4;

function emptyRuntime() {
  return {
    cache: {
      loadedAt: 0,
      sourceKey: '',
      channels: [],
      groups: ['Tumu'],
    },
    pendingLoad: null,
    pendingSourceKey: '',
  };
}

function runtimeForCurrentTenant() {
  const tenantId = getTenantId();
  const runtime = tenantCaches.get(tenantId) || emptyRuntime();
  // Move the active tenant to the back; drop only least-recently-used caches.
  tenantCaches.delete(tenantId);
  tenantCaches.set(tenantId, runtime);
  while (tenantCaches.size > MAX_TENANT_CACHES) {
    tenantCaches.delete(tenantCaches.keys().next().value);
  }
  return runtime;
}

function getSourceKey(source) {
  if (!source) return '';
  if (source.type === 'file') {
    return [source.id, source.updatedAt || '', source.channels?.length || 0].join(':');
  }
  return source.url || '';
}

function hasUsableCache(runtime, sourceKey) {
  return runtime.cache.sourceKey === sourceKey && runtime.cache.channels.length > 0;
}

function isCacheFresh(runtime, sourceKey) {
  const ageMs = Date.now() - runtime.cache.loadedAt;
  return hasUsableCache(runtime, sourceKey) && ageMs < config.cacheSeconds * 1000;
}

function buildGroups(channels) {
  return ['Tumu', ...new Set(channels.map((channel) => channel.group).sort((a, b) => a.localeCompare(b, 'tr')))];
}

function readPlaylist(response) {
  if (response.body?.getReader) return parseM3UStream(response.body, enrichChannel);
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

async function loadChannelsFromSource(source, runtime) {
  const sourceKey = getSourceKey(source);

  if (source.type === 'file') {
    const channels = readStoredPlaylist(source);
    const groups = buildGroups(channels);
    runtime.cache = {
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
      if (!response.ok) continue;

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
  runtime.cache = {
    loadedAt: Date.now(),
    sourceKey,
    channels,
    groups,
  };

  return { channels, groups, sourceReady: true, cached: false, stale: false };
}

export function clearChannelCache() {
  const tenantId = getTenantId();
  tenantCaches.set(tenantId, emptyRuntime());
}

export async function getChannels({ force = false } = {}) {
  const runtime = runtimeForCurrentTenant();
  const source = await getActivePlaylistSource();
  const sourceKey = getSourceKey(source);

  if (!source || !sourceKey) {
    clearChannelCache();
    return { channels: [], groups: ['Tumu'], sourceReady: false, cached: false, stale: false };
  }

  if (!force && hasUsableCache(runtime, sourceKey)) {
    return {
      channels: runtime.cache.channels,
      groups: runtime.cache.groups,
      sourceReady: true,
      cached: true,
      stale: !isCacheFresh(runtime, sourceKey),
    };
  }

  if (!force && runtime.pendingLoad && runtime.pendingSourceKey === sourceKey) {
    return runtime.pendingLoad;
  }

  runtime.pendingSourceKey = sourceKey;
  runtime.pendingLoad = loadChannelsFromSource(source, runtime).finally(() => {
    runtime.pendingLoad = null;
    runtime.pendingSourceKey = '';
  });

  return runtime.pendingLoad;
}

export async function findChannel(channelId) {
  const runtime = runtimeForCurrentTenant();
  const source = await getActivePlaylistSource();
  const sourceKey = getSourceKey(source);

  if (!source || !sourceKey) return null;

  if (hasUsableCache(runtime, sourceKey)) {
    return runtime.cache.channels.find((channel) => channel.id === String(channelId));
  }

  const { channels } = await getChannels();
  return channels.find((channel) => channel.id === String(channelId));
}
