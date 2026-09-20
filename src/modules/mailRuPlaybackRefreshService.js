import { resolveMailRuVideo } from './mailRuM3uService.js';
import { updateM3uYayinimChannelPlayback } from './sourceStorage.js';

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const pendingRefreshes = new Map();

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

async function resolveFreshMailRuVideo(pageUrl) {
  const key = String(pageUrl || '').trim();
  if (!key) throw new Error('Mail.ru kaynak sayfasi bulunamadi.');

  if (pendingRefreshes.has(key)) {
    return pendingRefreshes.get(key);
  }

  const pending = resolveMailRuVideo(key)
    .finally(() => pendingRefreshes.delete(key));

  pendingRefreshes.set(key, pending);
  return pending;
}

export async function refreshMailRuChannelForPlayback(channel) {
  if (!channel || channel.sourceKind !== 'mailru-m3u') return channel;

  const pageUrl = String(channel.pageUrl || '').trim();
  if (!pageUrl || !needsRefresh(channel.url)) return channel;

  const resolved = await resolveFreshMailRuVideo(pageUrl);
  const freshUrl = String(resolved?.best?.url || '').trim();

  if (!freshUrl) {
    const error = new Error('Mail.ru yayini icin guncel medya adresi alinamadi.');
    error.status = 502;
    throw error;
  }

  const freshPageUrl = String(resolved?.sourceUrl || pageUrl).trim();

  // findChannel() returns the cached channel object. Mutating it keeps the
  // current playback request in sync while the persistent copy is updated.
  channel.url = freshUrl;
  channel.pageUrl = freshPageUrl;

  await updateM3uYayinimChannelPlayback({
    channelId: channel.id,
    url: freshUrl,
    pageUrl: freshPageUrl,
  });

  return channel;
}
