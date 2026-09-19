import {
  extensionOf,
  isMediaContentType,
  looksLikeMediaUrl,
  mediaKind,
} from './extractors.js';
import { assertPublicHttpUrl, readTextLimited, safeFetch } from './urlSafety.js';

const PROBE_TIMEOUT_MS = 15_000;
const SEGMENT_TIMEOUT_MS = 8_000;
const DIRECT_PROBE_BYTES = 1_048_576;

function refererHeaders(candidate) {
  try {
    const referer = new URL(String(candidate?.sourcePage || '')).toString();
    return { referer };
  } catch {
    return {};
  }
}

function parseIsoDuration(value) {
  const match = String(value || '').match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;

  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  const seconds = Number(match[4] || 0);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total > 0 ? total : null;
}

function hlsHasDrm(text) {
  return (
    /#EXT-X-KEY:[^\r\n]*METHOD\s*=\s*SAMPLE-AES/i.test(text)
    || /#EXT-X-KEY:[^\r\n]*KEYFORMAT\s*=\s*"?(?!identity)[^,"\r\n]+/i.test(text)
    || /com\.apple\.streamingkeydelivery|widevine|playready/i.test(text)
  );
}

function dashHasDrm(text) {
  return /<ContentProtection\b/i.test(text)
    && /widevine|playready|fairplay|cenc|edef8ba9|9a04f079/i.test(text);
}

async function validateFirstHlsResource(text, manifestUrl, headers) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('#'));

  if (!line) throw new Error('HLS listesinde oynatilabilir kaynak bulunamadi.');

  const resourceUrl = new URL(line, manifestUrl).toString();
  const response = await safeFetch(resourceUrl, {
    signal: AbortSignal.timeout(SEGMENT_TIMEOUT_MS),
    headers: {
      ...headers,
      range: 'bytes=0-1',
    },
  });

  const ok = response.ok || response.status === 206;
  await response.body?.cancel().catch(() => {});
  if (!ok) throw new Error('HLS medya parcasi acilamadi: HTTP ' + response.status);
}

async function probeHls(candidate, url, depth = 0) {
  if (depth > 3) throw new Error('HLS yonlendirme derinligi asildi.');

  const headers = {
    accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
    ...refererHeaders(candidate),
  };
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers,
  });

  if (!response.ok) throw new Error('HLS listesi acilamadi: HTTP ' + response.status);
  const manifestUrl = response.url || url;
  const text = await readTextLimited(response, 1_000_000);
  if (!/^\s*#EXTM3U/m.test(text)) throw new Error('Gecerli bir HLS listesi degil.');
  if (hlsHasDrm(text)) throw new Error('DRM korumali HLS yayinlari desteklenmiyor.');

  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const lines = text.split(/\r?\n/);
    const variants = [];

    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim().startsWith('#EXT-X-STREAM-INF')) continue;
      const bandwidth = Number(lines[index].match(/BANDWIDTH=(\d+)/i)?.[1] || 0);
      const uri = lines.slice(index + 1).find((line) => line.trim() && !line.trim().startsWith('#'));
      if (uri) variants.push({ bandwidth, url: new URL(uri.trim(), manifestUrl).toString() });
    }

    const selected = variants.sort((left, right) => right.bandwidth - left.bandwidth)[0];
    if (!selected) throw new Error('HLS kalite listesinde alt yayin bulunamadi.');
    return probeHls(candidate, selected.url, depth + 1);
  }

  const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/gi)]
    .map((match) => Number(match[1]))
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  if (!durations.length && !/#EXT-X-TARGETDURATION/i.test(text)) {
    throw new Error('HLS listesinde medya parcasi bulunamadi.');
  }

  await validateFirstHlsResource(text, manifestUrl, headers);

  const ended = /#EXT-X-ENDLIST/i.test(text);
  const durationSeconds = ended && durations.length
    ? durations.reduce((total, duration) => total + duration, 0)
    : null;

  return {
    playable: true,
    kind: 'HLS',
    durationSeconds,
    live: !ended,
    resolvedUrl: url,
  };
}

async function probeDash(candidate, url) {
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: {
      accept: 'application/dash+xml,application/xml,text/xml,*/*',
      ...refererHeaders(candidate),
    },
  });

  if (!response.ok) throw new Error('DASH manifesti acilamadi: HTTP ' + response.status);
  const text = await readTextLimited(response, 1_200_000);
  if (!/<MPD\b/i.test(text)) throw new Error('Gecerli bir DASH manifesti degil.');
  if (dashHasDrm(text)) throw new Error('DRM korumali DASH yayinlari desteklenmiyor.');

  const durationValue = text.match(/mediaPresentationDuration\s*=\s*["']([^"']+)["']/i)?.[1];
  const dynamic = /<MPD\b[^>]*\btype\s*=\s*["']dynamic["']/i.test(text);

  return {
    playable: true,
    kind: 'DASH',
    durationSeconds: parseIsoDuration(durationValue),
    live: dynamic,
    resolvedUrl: response.url || url,
  };
}

async function readBufferLimited(response, maxBytes = DIRECT_PROBE_BYTES) {
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.subarray(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks);
}

export function parseMp4Duration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 28) return null;

  let offset = 0;
  while ((offset = buffer.indexOf('mvhd', offset, 'ascii')) !== -1) {
    try {
      const version = buffer[offset + 4];
      let timescale;
      let duration;

      if (version === 0 && offset + 24 <= buffer.length) {
        timescale = buffer.readUInt32BE(offset + 16);
        duration = buffer.readUInt32BE(offset + 20);
      } else if (version === 1 && offset + 36 <= buffer.length) {
        timescale = buffer.readUInt32BE(offset + 24);
        duration = Number(buffer.readBigUInt64BE(offset + 28));
      }

      if (timescale > 0 && Number.isFinite(duration) && duration > 0) {
        const seconds = duration / timescale;
        if (Number.isFinite(seconds) && seconds > 0) return seconds;
      }
    } catch {
      // Continue looking for another mvhd atom in malformed input.
    }
    offset += 4;
  }

  return null;
}

async function probeDirect(candidate) {
  const response = await safeFetch(candidate.url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: {
      accept: 'video/*,audio/*,application/octet-stream,*/*',
      range: `bytes=0-${DIRECT_PROBE_BYTES - 1}`,
      ...refererHeaders(candidate),
    },
  });

  if (!response.ok && response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Yayin baglantisi acilamadi: HTTP ' + response.status);
  }

  const finalUrl = response.url || candidate.url;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const contentRange = String(response.headers.get('content-range') || '');
  const rangeTotal = Number(contentRange.match(/\/(\d+)$/)?.[1] || 0);
  const contentLength = rangeTotal || Number(response.headers.get('content-length') || 0);
  const head = await readBufferLimited(response);

  if (contentType.includes('text/html') && !looksLikeMediaUrl(finalUrl)) {
    throw new Error('Baglanti medya yerine bir HTML sayfasi dondurdu.');
  }

  if (!isMediaContentType(contentType) && !looksLikeMediaUrl(finalUrl) && !looksLikeMediaUrl(candidate.url)) {
    throw new Error('Baglantinin video yayini oldugu dogrulanamadi.');
  }

  const kind = mediaKind(finalUrl, contentType);
  let durationSeconds = parseMp4Duration(head);

  if (!durationSeconds && ['MP4', 'MOV', 'M4V'].includes(kind) && contentLength > head.length) {
    const tailStart = Math.max(0, contentLength - DIRECT_PROBE_BYTES);
    const tailResponse = await safeFetch(finalUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        accept: 'video/*,application/octet-stream,*/*',
        range: `bytes=${tailStart}-${contentLength - 1}`,
        ...refererHeaders(candidate),
      },
    });

    if (tailResponse.ok || tailResponse.status === 206) {
      durationSeconds = parseMp4Duration(await readBufferLimited(tailResponse));
    } else {
      await tailResponse.body?.cancel().catch(() => {});
    }
  }

  return {
    playable: true,
    kind,
    durationSeconds,
    live: false,
    resolvedUrl: finalUrl,
    contentType,
    contentLength,
  };
}

export async function probeMediaCandidate(candidate) {
  await assertPublicHttpUrl(candidate?.url);
  const extension = extensionOf(candidate.url);
  const type = String(candidate.contentType || '').toLowerCase();

  if (extension === 'm3u8' || type.includes('mpegurl')) {
    return probeHls(candidate, candidate.url);
  }

  if (extension === 'mpd' || type.includes('dash+xml')) {
    return probeDash(candidate, candidate.url);
  }

  return probeDirect(candidate);
}
