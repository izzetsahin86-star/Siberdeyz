import { parseM3U } from './m3uParser.js';

const URL_PATTERN = /(https?:\/\/[^\s"'<>|]+)/ig;

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
    const cleaned = filePart.replace(/\.(m3u8?|ts|mp4|mkv|avi)$/i, '').trim();
    return cleaned || parsed.hostname || fallback;
  } catch {
    return fallback;
  }
}

function sanitizeChannels(channels, fileName) {
  const groupFallback = cleanFileName(fileName);
  const seen = new Set();
  const result = [];

  for (const channel of channels) {
    const url = cleanUrl(channel?.url);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;

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

    URL_PATTERN.lastIndex = 0;
    const matches = Array.from(line.matchAll(URL_PATTERN));

    for (const match of matches) {
      const url = cleanUrl(match[0]);
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

  const m3uChannels = parseM3U(text);
  const parsedChannels = m3uChannels.length > 0 ? m3uChannels : parsePlainPlaylist(text, fileName);
  const channels = sanitizeChannels(parsedChannels, fileName);

  if (channels.length === 0) {
    throw new Error('Dosyada yayin bulunamadi. M3U veya URL iceren TXT dosyasi yukleyin.');
  }

  return {
    channels,
    total: channels.length,
  };
}
