import { getPlaylistFetchCandidates } from './playlistCompatibility.js';

const CATALOG_TIMEOUT_MS = 9000;
const STREAM_TIMEOUT_MS = 7000;
const MAX_STREAM_SAMPLES = 3;
const MAX_PLAYLIST_BYTES = 384 * 1024;
const MAX_XTREAM_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CONCURRENT_VERIFICATIONS = 4;
const HARD_REJECTION_STATUSES = new Set([401, 403, 458]);

let activeVerifications = 0;
const verificationQueue = [];

async function withVerificationSlot(task) {
  if (activeVerifications >= MAX_CONCURRENT_VERIFICATIONS) {
    await new Promise((resolve) => verificationQueue.push(resolve));
  }

  activeVerifications += 1;

  try {
    return await task();
  } finally {
    activeVerifications -= 1;
    const next = verificationQueue.shift();
    if (next) next();
  }
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

function isTimeoutError(error) {
  const name = String(error?.name || '');
  return name === 'TimeoutError' || name === 'AbortError';
}

function cleanExtension(value, fallback = 'ts') {
  const extension = String(value || '').trim().toLowerCase().replace(/^\.+/, '');
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : fallback;
}

function getXtreamConnection(source) {
  try {
    const parsed = new URL(String(source?.url || ''));
    const username = parsed.searchParams.get('username');
    const password = parsed.searchParams.get('password');

    if (!username || !password) return null;

    return {
      origin: parsed.origin,
      username,
      password,
      preferredExtension: parsed.searchParams.get('output') === 'm3u8' ? 'm3u8' : 'ts',
    };
  } catch {
    return null;
  }
}

function chooseSamples(items, limit = MAX_STREAM_SAMPLES) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (list.length <= limit) return list;

  const indexes = [0, Math.floor(list.length / 2), list.length - 1];
  const selected = [];
  const seen = new Set();

  for (const index of indexes) {
    if (selected.length >= limit) break;
    const item = list[index];
    const key = String(item?.stream_id ?? item?.url ?? index);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
  }

  return selected;
}

async function cancelBody(response) {
  if (!response?.body) return;

  try {
    await response.body.cancel();
  } catch {
    // Govdeyi kapatmak dogrulama sonucunu degistirmez.
  }
}

async function probeStreamUrl(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'user-agent': 'Siberdeyz-IPTV-Stream-Verifier/1.0',
        range: 'bytes=0-4095',
        accept: '*/*',
      },
      redirect: 'follow',
      signal: timeoutSignal(STREAM_TIMEOUT_MS),
    });

    if (!response.ok && response.status !== 206) {
      await cancelBody(response);
      return {
        ok: false,
        status: response.status,
        hardRejected: HARD_REJECTION_STATUSES.has(response.status),
        reason: 'HTTP ' + response.status,
      };
    }

    const reader = response.body?.getReader?.();

    if (!reader) {
      await cancelBody(response);
      return {
        ok: true,
        status: response.status,
        hardRejected: false,
        reason: 'Yayin cevabi alindi.',
      };
    }

    try {
      const { value, done } = await reader.read();
      const byteLength = value?.byteLength || 0;

      if (byteLength > 0) {
        return {
          ok: true,
          status: response.status,
          hardRejected: false,
          reason: 'Yayin verisi alindi.',
        };
      }

      return {
        ok: !done,
        status: response.status,
        hardRejected: false,
        reason: done ? 'Yayin veri gondermedi.' : 'Yayin cevabi alindi.',
      };
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ilk veri parcasi yeterli.
      }
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      hardRejected: false,
      reason: isTimeoutError(error)
        ? 'Yayin zaman asimina ugradi.'
        : 'Yayina ulasilamadi.',
    };
  }
}

async function readCatalogJsonLimited(response) {
  const expected = Number(response.headers.get('content-length'));
  if (Number.isFinite(expected) && expected > MAX_XTREAM_CATALOG_BYTES) {
    await cancelBody(response);
    return { oversized: true };
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_XTREAM_CATALOG_BYTES) return { oversized: true };
    return { data: JSON.parse(text) };
  }

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value?.byteLength || 0;
      if (totalBytes > MAX_XTREAM_CATALOG_BYTES) {
        await reader.cancel();
        return { oversized: true };
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return { data: JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')) };
}

async function fetchXtreamLiveStreams(source) {
  const connection = getXtreamConnection(source);
  if (!connection) {
    return { connection: null, streams: [], error: 'Xtream bilgileri okunamadi.' };
  }

  const apiUrl = new URL('/player_api.php', connection.origin);
  apiUrl.searchParams.set('username', connection.username);
  apiUrl.searchParams.set('password', connection.password);
  apiUrl.searchParams.set('action', 'get_live_streams');

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'user-agent': 'Siberdeyz-IPTV-Stream-Verifier/1.0',
        accept: 'application/json,text/plain,*/*',
      },
      redirect: 'follow',
      signal: timeoutSignal(CATALOG_TIMEOUT_MS),
    });

    if (!response.ok) {
      await cancelBody(response);
      return {
        connection,
        streams: [],
        status: response.status,
        hardRejected: HARD_REJECTION_STATUSES.has(response.status),
        error: 'Canli yayin listesi HTTP ' + response.status,
      };
    }

    const catalog = await readCatalogJsonLimited(response);
    if (catalog.oversized) {
      return {
        connection,
        streams: [],
        status: response.status,
        hardRejected: false,
        error: 'Canli yayin listesi bellek guvenligi icin cok buyuk; API durumu esas alindi.',
      };
    }
    const data = catalog.data;
    const streams = Array.isArray(data)
      ? data.filter((item) => item && item.stream_id != null)
      : [];

    return { connection, streams, status: response.status, hardRejected: false, error: '' };
  } catch (error) {
    return {
      connection,
      streams: [],
      status: 0,
      hardRejected: false,
      error: isTimeoutError(error)
        ? 'Canli yayin listesi zaman asimina ugradi.'
        : 'Canli yayin listesi alinamadi.',
    };
  }
}

function buildXtreamStreamUrl(connection, stream) {
  const streamId = String(stream?.stream_id ?? '').trim();
  if (!streamId) return '';

  const extension = cleanExtension(
    stream?.container_extension,
    connection.preferredExtension
  );

  const url = new URL(
    '/live/'
      + encodeURIComponent(connection.username)
      + '/'
      + encodeURIComponent(connection.password)
      + '/'
      + encodeURIComponent(streamId)
      + '.'
      + extension,
    connection.origin
  );

  return url.toString();
}

async function verifyXtreamStreamsInternal(source) {
  const catalog = await fetchXtreamLiveStreams(source);

  if (!catalog.connection) {
    return {
      verified: false,
      definitiveFailure: false,
      testedStreams: 0,
      verifiedStreams: 0,
      message: catalog.error,
    };
  }

  if (catalog.streams.length === 0) {
    return {
      verified: false,
      definitiveFailure: Boolean(catalog.hardRejected),
      testedStreams: 0,
      verifiedStreams: 0,
      message: catalog.error || 'Canli yayin bulunamadi.',
    };
  }

  const samples = chooseSamples(catalog.streams);
  let testedStreams = 0;
  let hardRejectedStreams = 0;
  let lastReason = '';

  for (const stream of samples) {
    const streamUrl = buildXtreamStreamUrl(catalog.connection, stream);
    if (!streamUrl) continue;

    testedStreams += 1;
    const probe = await probeStreamUrl(streamUrl);
    lastReason = probe.reason;

    if (probe.ok) {
      return {
        verified: true,
        definitiveFailure: false,
        testedStreams,
        verifiedStreams: 1,
        message: 'Gercek yayin verisi dogrulandi.',
      };
    }

    if (probe.hardRejected) hardRejectedStreams += 1;
  }

  return {
    verified: false,
    definitiveFailure: testedStreams > 0 && hardRejectedStreams === testedStreams,
    testedStreams,
    verifiedStreams: 0,
    message: lastReason || 'Ornek yayinlar dogrulanamadi.',
  };
}

async function extractPlaylistStreamUrls(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return [];

  const decoder = new TextDecoder();
  const urls = [];
  let buffered = '';
  let totalBytes = 0;

  try {
    while (urls.length < MAX_STREAM_SAMPLES && totalBytes < MAX_PLAYLIST_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value?.byteLength || 0;
      buffered += decoder.decode(value || new Uint8Array(), { stream: true });

      let lineEnd = buffered.indexOf('\n');
      while (lineEnd !== -1 && urls.length < MAX_STREAM_SAMPLES) {
        const line = buffered.slice(0, lineEnd).trim();
        buffered = buffered.slice(lineEnd + 1);

        if (line && !line.startsWith('#')) {
          try {
            const streamUrl = new URL(line, response.url).toString();
            if (/^https?:\/\//i.test(streamUrl)) urls.push({ url: streamUrl });
          } catch {
            // Gecersiz satir atlanir.
          }
        }

        lineEnd = buffered.indexOf('\n');
      }
    }

    if (urls.length < MAX_STREAM_SAMPLES) {
      const line = buffered.trim();
      if (line && !line.startsWith('#')) {
        try {
          const streamUrl = new URL(line, response.url).toString();
          if (/^https?:\/\//i.test(streamUrl)) urls.push({ url: streamUrl });
        } catch {
          // Son satir gecersizse atlanir.
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Yeterli ornek toplandi.
    }
  }

  return urls.slice(0, MAX_STREAM_SAMPLES);
}

async function verifyPlaylistStreamsInternal(source) {
  const candidates = getPlaylistFetchCandidates(source?.url);
  let playlistReachable = false;
  let lastMessage = 'Listeye ulasilamadi.';
  let hardRejected = false;

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, {
        headers: {
          'user-agent': 'Siberdeyz-IPTV-Stream-Verifier/1.0',
          accept: 'application/x-mpegURL,text/plain,*/*',
        },
        redirect: 'follow',
        signal: timeoutSignal(CATALOG_TIMEOUT_MS),
      });

      if (!response.ok) {
        hardRejected = hardRejected || HARD_REJECTION_STATUSES.has(response.status);
        lastMessage = 'Liste HTTP ' + response.status;
        await cancelBody(response);
        continue;
      }

      playlistReachable = true;
      const samples = await extractPlaylistStreamUrls(response);

      if (samples.length === 0) {
        lastMessage = 'Liste erisilebilir ancak ornek yayin bulunamadi.';
        continue;
      }

      let testedStreams = 0;
      let hardRejectedStreams = 0;

      for (const sample of samples) {
        testedStreams += 1;
        const probe = await probeStreamUrl(sample.url);
        lastMessage = probe.reason;

        if (probe.ok) {
          return {
            verified: true,
            definitiveFailure: false,
            playlistReachable: true,
            testedStreams,
            verifiedStreams: 1,
            message: 'Liste ve gercek yayin verisi dogrulandi.',
          };
        }

        if (probe.hardRejected) hardRejectedStreams += 1;
      }

      return {
        verified: false,
        definitiveFailure: testedStreams > 0 && hardRejectedStreams === testedStreams,
        playlistReachable: true,
        testedStreams,
        verifiedStreams: 0,
        message: lastMessage,
      };
    } catch (error) {
      lastMessage = isTimeoutError(error)
        ? 'Liste zaman asimina ugradi.'
        : 'Listeye ulasilamadi.';
    }
  }

  return {
    verified: false,
    definitiveFailure: hardRejected && !playlistReachable,
    playlistReachable,
    testedStreams: 0,
    verifiedStreams: 0,
    message: lastMessage,
  };
}

export function verifyXtreamStreams(source) {
  return withVerificationSlot(() => verifyXtreamStreamsInternal(source));
}

export function verifyPlaylistStreams(source) {
  return withVerificationSlot(() => verifyPlaylistStreamsInternal(source));
}
