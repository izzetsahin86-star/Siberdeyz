import { resolveMailRuVideo } from './mailRuM3uService.js';
import { updateM3uYayinimChannelPlayback } from './sourceStorage.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const pendingRefreshes = new Map();
const refreshedVideos = new Map();

function parseExpireAtMs(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;

  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;

  return numeric > 10_000_000_000 ? numeric : numeric * 1000;
}

function needsRefresh(url) {
  try {
    const parsed = new URL(String(url || ''));
    const expireAtMs = parseExpireAtMs(parsed.searchParams.get('expire_at'));

    if (!expireAtMs) return false;
    return expireAtMs <= Date.now() + REFRESH_MARGIN_MS;
  } catch {
    return true;
  }
}

function mediaIdentity(url) {
  try {
    const parsed = new URL(String(url || ''));
    const pathname = decodeURIComponent(parsed.pathname || '').toLocaleLowerCase('tr-TR');
    const base = pathname.split('/').pop() || '';
    const numeric = base.match(/\d{6,}/)?.[0];

    if (numeric) return 'id:' + numeric;

    return 'file:' + base
      .replace(/\.(?:mp4|m3u8|mov|m4v|3gp|3g2)$/i, '')
      .replace(/(?:^|[-_.\s])(2160|1440|1080|720|576|540|480|360|240)p?(?=$|[-_.\s])/gi, '')
      .replace(/[^a-z0-9\u00c0-\u024f]+/gi, '')
      .trim();
  } catch {
    return '';
  }
}

function resolvedMatchesOriginal(resolved, originalUrl) {
  const originalIdentity = mediaIdentity(originalUrl);
  if (!originalIdentity) return false;

  return (resolved?.videos || []).some((item) => mediaIdentity(item?.url) === originalIdentity);
}

function collectLegacyIdCandidates(url) {
  const ids = new Set();

  try {
    const parsed = new URL(String(url || ''));
    const values = [
      parsed.pathname,
      parsed.searchParams.get('video_key') || '',
      parsed.searchParams.get('p') || '',
      ...parsed.searchParams.getAll('slave[]'),
    ];

    for (const value of values) {
      let decoded = String(value || '');
      try { decoded = decodeURIComponent(decoded); } catch {}

      for (const match of decoded.matchAll(/\d{6,20}/g)) {
        ids.add(match[0]);
        if (ids.size >= 6) break;
      }

      if (ids.size >= 6) break;
    }
  } catch {}

  return [...ids];
}

async function resolveFreshMailRuVideo(pageUrl) {
  const key = String(pageUrl || '').trim();
  if (!key) throw new Error('Mail.ru kaynak sayfasi bulunamadi.');

  const cached = refreshedVideos.get(key);
  if (cached?.best?.url && !needsRefresh(cached.best.url)) {
    return cached;
  }

  if (pendingRefreshes.has(key)) {
    return pendingRefreshes.get(key);
  }

  const pending = resolveMailRuVideo(key)
    .then((resolved) => {
      refreshedVideos.set(key, resolved);
      return resolved;
    })
    .finally(() => pendingRefreshes.delete(key));

  pendingRefreshes.set(key, pending);
  return pending;
}

async function recoverLegacySource(channel) {
  const originalUrl = String(channel?.url || '').trim();

  for (const candidate of collectLegacyIdCandidates(originalUrl)) {
    const pageUrl = 'https://my.mail.ru/video/embed/' + encodeURIComponent(candidate);

    try {
      const resolved = await resolveFreshMailRuVideo(pageUrl);
      if (resolvedMatchesOriginal(resolved, originalUrl)) {
        return { resolved, pageUrl };
      }
    } catch {}
  }

  const fallbackPageUrl = String(channel?.mailRuLegacySourcePageUrl || '').trim();
  if (fallbackPageUrl) {
    try {
      const resolved = await resolveFreshMailRuVideo(fallbackPageUrl);
      if (resolvedMatchesOriginal(resolved, originalUrl)) {
        return { resolved, pageUrl: String(resolved?.sourceUrl || fallbackPageUrl).trim() };
      }
    } catch {}
  }

  const error = new Error(
    'Bu eski Mail.ru kaydinin ozgun kaynak adresi bulunamadi. Yanlis video acilmamasi icin otomatik eslestirme durduruldu.'
  );
  error.status = 422;
  throw error;
}

export async function refreshMailRuChannelForPlayback(channel) {
  if (!channel || channel.sourceKind !== 'mailru-m3u') return channel;
  if (!needsRefresh(channel.url)) return channel;

  let pageUrl = String(channel.pageUrl || '').trim();
  let resolved;
  let recoveredLegacy = false;

  if (pageUrl) {
    resolved = await resolveFreshMailRuVideo(pageUrl);
  } else if (channel.mailRuLegacyPageUrl) {
    const recovered = await recoverLegacySource(channel);
    resolved = recovered.resolved;
    pageUrl = recovered.pageUrl;
    recoveredLegacy = true;
  } else {
    const error = new Error('Mail.ru kaynak sayfasi bulunamadi.');
    error.status = 422;
    throw error;
  }

  const freshUrl = String(resolved?.best?.url || '').trim();

  if (!freshUrl) {
    const error = new Error('Mail.ru yayini icin guncel medya adresi alinamadi.');
    error.status = 502;
    throw error;
  }

  // Never accept a legacy recovery that resolves to a different video.
  if (recoveredLegacy && !resolvedMatchesOriginal(resolved, channel.url)) {
    const error = new Error('Eski Mail.ru kaydi farkli bir videoya eslesti; oynatma iptal edildi.');
    error.status = 409;
    throw error;
  }

  const freshPageUrl = String(resolved?.sourceUrl || pageUrl).trim();

  channel.url = freshUrl;
  channel.pageUrl = freshPageUrl;
  channel.mailRuLegacyPageUrl = false;

  await updateM3uYayinimChannelPlayback({
    channelId: channel.id,
    url: freshUrl,
    pageUrl: freshPageUrl,
  });

  return channel;
}
