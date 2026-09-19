import crypto from 'crypto';
import { canonicalPageUrl, isSameSite } from './urlSafety.js';

export const MEDIA_EXTENSIONS = new Set([
  'm3u8', 'mpd', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'flv', 'ts', 'm2ts',
]);

const NON_PAGE_EXTENSIONS = new Set([
  ...MEDIA_EXTENSIONS,
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico',
  'css', 'js', 'json', 'xml', 'pdf', 'zip', 'rar', '7z', 'gz',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'woff', 'woff2', 'ttf',
]);

export function normalizeSearchText(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function queryScore(value, query) {
  const haystack = normalizeSearchText(value);
  const needle = normalizeSearchText(query);
  if (!haystack || !needle) return 0;

  const tokens = needle.split(' ').filter((token) => token.length >= 2);
  if (!tokens.length) return 0;

  let score = haystack.includes(needle) ? 30 : 0;
  let hits = 0;

  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    hits += 1;
    score += token.length >= 5 ? 7 : 4;
  }

  if (hits === tokens.length) score += 18;
  else if (hits / tokens.length >= 0.6) score += 5;
  return score;
}

export function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#(\d+);/g, (full, code) => {
      const valueCode = Number(code);
      return Number.isInteger(valueCode) && valueCode > 0 && valueCode <= 0x10ffff
        ? String.fromCodePoint(valueCode)
        : full;
    });
}

export function stripHtml(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function pageTitleFromHtml(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 180) : '';
}

export function extensionOf(value) {
  try {
    const pathname = new URL(String(value || '')).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{1,8})$/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export function looksLikeMediaUrl(value) {
  return MEDIA_EXTENSIONS.has(extensionOf(value));
}

export function isMediaContentType(value) {
  const type = String(value || '').toLowerCase();
  return (
    type.startsWith('video/')
    || type.startsWith('audio/')
    || type.includes('mpegurl')
    || type.includes('dash+xml')
    || type.includes('mp2t')
  );
}

export function mediaKind(value, contentType = '') {
  const extension = extensionOf(value);
  if (extension === 'm3u8' || String(contentType).toLowerCase().includes('mpegurl')) return 'HLS';
  if (extension === 'mpd' || String(contentType).toLowerCase().includes('dash+xml')) return 'DASH';
  return extension ? extension.toUpperCase() : 'VIDEO';
}

export function mediaId(value) {
  return 'pro_' + crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

export function safeMediaName(value, fallbackIndex = 1, title = '') {
  const cleanTitle = stripHtml(title).replace(/\s+/g, ' ').trim();
  if (cleanTitle && !/^(loading|please wait|just a moment)$/i.test(cleanTitle)) {
    return cleanTitle.slice(0, 120);
  }

  try {
    const parsed = new URL(String(value || ''));
    const part = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\.(?:m3u8|mpd|mp4|m4v|mov|webm|mkv|avi|flv|ts|m2ts)$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (part && !/^(index|master|playlist|manifest)$/i.test(part)) return part.slice(0, 120);
  } catch {
    // Fallback is used below.
  }

  return 'Bulunan Yayin ' + fallbackIndex;
}

function normalizeEmbeddedText(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u003[aA]/g, ':')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
}

function addMediaUrl(store, rawValue, baseUrl, meta = {}) {
  const cleaned = String(rawValue || '')
    .trim()
    .replace(/[),.;]+$/, '')
    .replace(/^['"]|['"]$/g, '');
  if (!cleaned || /^(?:data|blob|javascript):/i.test(cleaned)) return;

  try {
    const url = new URL(cleaned, baseUrl).toString();
    if (!/^https?:\/\//i.test(url)) return;
    if (!looksLikeMediaUrl(url) && !meta.allowUnknown) return;

    const existing = store.get(url);
    if (!existing || Number(meta.confidence || 0) > Number(existing.confidence || 0)) {
      store.set(url, {
        url,
        title: String(meta.title || '').slice(0, 180),
        sourcePage: String(meta.sourcePage || baseUrl || '').slice(0, 800),
        discoveredBy: String(meta.discoveredBy || 'html'),
        contentType: String(meta.contentType || '').slice(0, 120),
        confidence: Number(meta.confidence || 50),
        explicit: Boolean(meta.explicit),
      });
    }
  } catch {
    // Invalid embedded URL is ignored.
  }
}

export function extractMediaCandidatesFromText(text, baseUrl, meta = {}) {
  const normalized = normalizeEmbeddedText(text).slice(0, 2_500_000);
  const found = new Map();
  const extensions = '(?:m3u8|mpd|mp4|m4v|mov|webm|mkv|avi|flv|m2ts|ts)';

  const absolutePattern = new RegExp('https?:\\/\\/[^"\'<>\\s\\\\]+?\\.' + extensions + '(?:\\?[^"\'<>\\s\\\\]*)?', 'gi');
  for (const match of normalized.matchAll(absolutePattern)) {
    addMediaUrl(found, match[0], baseUrl, { ...meta, confidence: 85 });
  }

  const assignedPattern = new RegExp('(?:src|href|file|url|source|manifest|playlist)\\s*[:=]\\s*["\']([^"\']+?\\.' + extensions + '(?:\\?[^"\']*)?)["\']', 'gi');
  for (const match of normalized.matchAll(assignedPattern)) {
    addMediaUrl(found, match[1], baseUrl, { ...meta, confidence: 80 });
  }

  return [...found.values()];
}

export function extractIframeUrls(html, baseUrl) {
  const found = new Set();
  const pattern = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;

  for (const match of String(html || '').slice(0, 2_500_000).matchAll(pattern)) {
    try {
      const url = new URL(decodeHtmlEntities(match[1]), baseUrl).toString();
      if (/^https?:\/\//i.test(url)) found.add(url);
    } catch {
      // Ignore malformed iframe URLs.
    }
  }

  return [...found].slice(0, 20);
}

export function shouldVisitPage(value) {
  try {
    const parsed = new URL(String(value || ''));
    const extension = extensionOf(parsed);
    if (NON_PAGE_EXTENSIONS.has(extension)) return false;
    return !/\/(?:logout|signout)(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function extractPageLinks(html, baseUrl, rootHostname, query = '') {
  const ranked = new Map();
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let inspected = 0;

  for (const match of String(html || '').slice(0, 2_500_000).matchAll(pattern)) {
    inspected += 1;
    if (inspected > 2_000) break;

    try {
      const url = canonicalPageUrl(new URL(decodeHtmlEntities(match[1]), baseUrl).toString());
      if (!url || !shouldVisitPage(url)) continue;

      const parsed = new URL(url);
      if (!isSameSite(rootHostname, parsed.hostname)) continue;

      const label = stripHtml(match[2]).slice(0, 220);
      const combined = label + ' ' + parsed.pathname + ' ' + parsed.search;
      let score = query ? queryScore(combined, query) : 0;

      if (/watch|izle|film|movie|video|episode|bolum|player|dizi/i.test(parsed.pathname)) score += 8;
      if (/login|register|privacy|terms|contact|iletisim|gizlilik/i.test(parsed.pathname)) score -= 20;

      const current = ranked.get(url);
      if (!current || score > current.score) {
        ranked.set(url, { url, title: label, score, source: 'html-link' });
      }
    } catch {
      // Ignore malformed links.
    }
  }

  return [...ranked.values()].sort((left, right) => right.score - left.score);
}
