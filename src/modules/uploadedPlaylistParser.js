import { parseM3U } from './m3uParser.js';

const URL_PATTERN = /(https?:\/\/[^\s"'<>|]+)/ig;
const PLAYLIST_EXT_PATTERN = /\.(m3u|m3u_plus)(?:$|[?#])/i;
const STREAM_EXT_PATTERN = /\.(m3u8|ts|mp4|mkv|avi|mov)(?:$|[?#])/i;

function cleanFileName(fileName) {
  return String(fileName || 'Dosya').replace(/\.[^.]+$/, '').trim() || 'Dosya';
}

function cleanUrl(value) {
  return String(value || '').trim().replace(/[),;\]}]+$/g, '');
}

function cleanName(value) {
  return String(value || '')
    .replace(/^\s*[#>\-*,;:|]+\s*/g, '')
    .replace(/\s*[#>\-*,;:|]+\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameFromUrl(url, fallback) {
  try {
    const parsed = new URL(url);
    const filePart = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const cleaned = filePart.replace(/\.(m3u8?|m3u_plus|ts|mp4|mkv|avi)$/i, '').trim();
    return cleaned || parsed.hostname || fallback;
  } catch {
    return fallback;
  }
}

function toPlaylistSourceUrl(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLocaleLowerCase('tr-TR');
    const params = parsed.searchParams;
    const hasLogin = params.has('username') && params.has('password');
    const isXtreamEndpoint = hasLogin && /(\/get\.php|\/player_api\.php|\/xmltv\.php)$/i.test(path);

    if (isXtreamEndpoint) {
      parsed.pathname = parsed.pathname.replace(/\/(?:get|player_api|xmltv)\.php$/i, '/get.php');
      if (!params.has('type')) params.set('type', 'm3u_plus');
      if (!params.has('output')) params.set('output', 'ts');
      return parsed.toString();
    }

    if (PLAYLIST_EXT_PATTERN.test(path)) return url;

    return '';
  } catch {
    return '';
  }
}

function isPlaylistSourceUrl(url) {
  return Boolean(toPlaylistSourceUrl(url));
}

function looksLikeDirectStream(url) {
  try {
    const parsed = new URL(url);
    return STREAM_EXT_PATTERN.test(parsed.pathname.toLocaleLowerCase('tr-TR'));
  } catch {
    return false;
  }
}

function extractUrls(line) {
  URL_PATTERN.lastIndex = 0;
  return Array.from(line.matchAll(URL_PATTERN)).map((match) => ({
    url: cleanUrl(match[0]),
    index: match.index || 0,
  }));
}

function parsePlaylistSources(text, fileName) {
  const fallback = cleanFileName(fileName);
  const lines = String(text || '').split(/\r?\n/);
  const seen = new Set();
  const sources = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    for (const match of extractUrls(line)) {
      const sourceUrl = toPlaylistSourceUrl(match.url);
      if (!sourceUrl || looksLikeDirectStream(match.url) || seen.has(sourceUrl)) continue;

      seen.add(sourceUrl);
      const label = cleanName(line.slice(0, match.index)) || nameFromUrl(sourceUrl, fallback + ' ' + (sources.length + 1));
      sources.push({ url: sourceUrl, label });
    }
  }

  return sources;
}

function sanitizeChannels(channels, fileName) {
  const groupFallback = cleanFileName(fileName);
  const seen = new Set();
  const result = [];

  for (const channel of channels) {
    const url = cleanUrl(channel?.url);
    if (!/^https?:\/\//i.test(url) || isPlaylistSourceUrl(url) || seen.has(url)) continue;

    seen.add(url);
    const index = result.length;
    result.push({
      id: String(index + 1),
      name: cleanName(channel?.name) || nameFromUrl(url, 'Yayin ' + (index + 1)),
      logo: String(channel?.logo || '').trim(),
      group: cleanName(channel?.group) || groupFallback,
      tvgId: String(channel?.tvgId || '').trim(),
      url,
    });
  }

  return result;
}

function parsePlainPlaylist(text, fileName) {
  const group = cleanFileName(fileName);
  const channels = [];
  const lines = String(text || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    for (const match of extractUrls(line)) {
      const url = match.url;
      if (isPlaylistSourceUrl(url)) continue;

      const beforeUrl = line.slice(0, match.index);
      const name = cleanName(beforeUrl) || nameFromUrl(url, 'Yayin ' + (channels.length + 1));

      channels.push({
        id: String(channels.length + 1),
        name,
        logo: '',
        group,
        tvgId: '',
        url,
      });
    }
  }

  return channels;
}

export function parseUploadedPlaylist(content, fileName = 'Dosya') {
  const text = String(content || '').replace(/^\uFEFF/, '');

  if (!text.trim()) {
    throw new Error('Dosya bos gorunuyor.');
  }

  const sourceLinks = parsePlaylistSources(text, fileName);
  if (sourceLinks.length > 0) {
    return {
      kind: 'sources',
      sources: sourceLinks,
      total: sourceLinks.length,
    };
  }

  const m3uChannels = parseM3U(text);
  const parsedChannels = m3uChannels.length > 0 ? m3uChannels : parsePlainPlaylist(text, fileName);
  const channels = sanitizeChannels(parsedChannels, fileName);

  if (channels.length === 0) {
    throw new Error('Dosyada yayin bulunamadi. M3U kanal listesi veya playlist linki olan TXT yukleyin.');
  }

  return {
    kind: 'channels',
    channels,
    total: channels.length,
  };
}
