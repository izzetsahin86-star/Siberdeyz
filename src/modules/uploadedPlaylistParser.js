import { parseM3U } from './m3uParser.js';

const URL_PATTERN = /(https?:\/\/[^\s"'<>|]+)/ig;
const PLAYLIST_EXT_PATTERN = /\.(m3u|m3u_plus)(?:$|[?#])/i;
const STREAM_EXT_PATTERN = /\.(m3u8|ts|mp4|mkv|avi|mov)(?:$|[?#])/i;
const SOCIAL_HOSTS = new Set(['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me']);

const FIELD_PATTERNS = {
  portal: /(?:Portal|ƤσятαƖ)\s*[=:]?\s*(https?:\/\/[^\s"'<>|]+)/iu,
  realUrl: /(?:Real\s*Url|ℝ𝕖𝕒𝕝\s*𝕌𝕣𝕝|ʀєɑℓ\s*µʀℓ)\s*[=:]?\s*(https?:\/\/[^\s"'<>|]+)/iu,
  user: /(?:User|Username|υѕєя)\s*[=:]?\s*([^\s]+)/iu,
  pass: /(?:Pass|Password|ραѕѕ)\s*[=:]?\s*([^\s]+)/iu,
};

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
    const isGetPhp = hasLogin && /\/get\.php$/i.test(path);
    const isConvertibleXtreamEndpoint = hasLogin && /\/(?:player_api|xmltv)\.php$/i.test(path);

    // TXT icindeki get.php hesap linki, URL Ekle ile girilmis gibi
    // hic degistirilmeden saklanmali. Provider'a ait query parametrelerine dokunma.
    if (isGetPhp) return url;

    if (isConvertibleXtreamEndpoint) {
      parsed.pathname = parsed.pathname.replace(/\/(?:player_api|xmltv)\.php$/i, '/get.php');
      if (!params.has('type')) params.set('type', 'm3u_plus');
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

function sourceIdentity(url) {
  try {
    const parsed = new URL(url);
    const username = parsed.searchParams.get('username');
    const password = parsed.searchParams.get('password');

    if (username !== null && password !== null) {
      return [
        parsed.protocol.toLocaleLowerCase('en-US'),
        parsed.host.toLocaleLowerCase('en-US'),
        username,
        password,
      ].join('|');
    }

    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

function sourceDefaultLabel(url, fallback) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const username = parsed.searchParams.get('username');

    if (host && username) return host + ' - ' + username;
    return host || fallback;
  } catch {
    return fallback;
  }
}

function isGenericSourcePrefix(value) {
  const normalized = String(value || '')
    .replace(/[╠•●۞🎬🔰👀=:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('tr-TR');

  return [
    'm3u',
    'm3u1',
    'm3u2',
    'playlist',
    'url',
    'real url',
    'portal',
    'ʀєɑℓ µʀℓ',
    'ℝ𝕖𝕒𝕝 𝕌𝕣𝕝',
    'ƤσятαƖ',
  ].some((token) => normalized === token.toLocaleLowerCase('tr-TR'));
}

function addPlaylistSource(sources, seen, sourceUrl, labelCandidate, fallback) {
  if (!sourceUrl || looksLikeDirectStream(sourceUrl)) return false;

  const identity = sourceIdentity(sourceUrl);
  if (seen.has(identity)) return false;

  seen.add(identity);
  const cleanedCandidate = cleanName(labelCandidate);
  const label = cleanedCandidate && !isGenericSourcePrefix(cleanedCandidate)
    ? cleanedCandidate
    : sourceDefaultLabel(sourceUrl, fallback + ' ' + (sources.length + 1));

  sources.push({ url: sourceUrl, label });
  return true;
}

function buildSourceFromAccountBlock(block) {
  const baseUrl = cleanUrl(block.realUrl || block.portal);
  const username = String(block.username || '').trim();
  const password = String(block.password || '').trim();

  if (!baseUrl || !username || !password) return '';

  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = '/get.php';
    parsed.search = '';
    parsed.hash = '';
    parsed.searchParams.set('username', username);
    parsed.searchParams.set('password', password);
    parsed.searchParams.set('type', 'm3u_plus');
    return parsed.toString();
  } catch {
    return '';
  }
}

function parseAccountBlocks(lines, sources, seen, fallback) {
  let block = {};

  const flush = () => {
    const generated = buildSourceFromAccountBlock(block);
    if (generated) addPlaylistSource(sources, seen, generated, '', fallback);
    block = {};
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (block.username && block.password && (block.realUrl || block.portal)) flush();
      continue;
    }

    const portalMatch = line.match(FIELD_PATTERNS.portal);
    if (portalMatch) {
      if (block.portal && block.username && block.password) flush();
      block.portal = cleanUrl(portalMatch[1]);
    }

    const realMatch = line.match(FIELD_PATTERNS.realUrl);
    if (realMatch) block.realUrl = cleanUrl(realMatch[1]);

    const userMatch = line.match(FIELD_PATTERNS.user);
    if (userMatch) block.username = userMatch[1].trim();

    const passMatch = line.match(FIELD_PATTERNS.pass);
    if (passMatch) block.password = passMatch[1].trim();
  }

  flush();
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
      if (!sourceUrl) continue;

      addPlaylistSource(
        sources,
        seen,
        sourceUrl,
        line.slice(0, match.index),
        fallback
      );
    }
  }

  // Bazi TXT ciktilarinda get.php satiri bulunmayabilir; Portal/Real URL + User + Pass
  // alanlarindan ayni Xtream M3U URL'sini olustur.
  parseAccountBlocks(lines, sources, seen, fallback);

  return sources;
}

function looksLikeMetadataOrSocialUrl(line, url) {
  try {
    const parsed = new URL(url);
    if (SOCIAL_HOSTS.has(parsed.hostname.toLocaleLowerCase('en-US'))) return true;
  } catch {
    return false;
  }

  return Boolean(
    line.match(FIELD_PATTERNS.portal)
    || line.match(FIELD_PATTERNS.realUrl)
  );
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
      if (isPlaylistSourceUrl(url) || looksLikeMetadataOrSocialUrl(line, url)) continue;

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
