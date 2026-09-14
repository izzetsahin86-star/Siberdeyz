import { once } from 'events';
import { findChannel } from './playlistService.js';

const PASS_THROUGH_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
]);

function buildUpstreamHeaders(req, { includeRange = true } = {}) {
  const headers = {
    'user-agent': req.get('user-agent') || 'Siberdeyz-IPTV-Player/1.0',
    accept: '*/*',
    'accept-language': req.get('accept-language') || 'tr-TR,tr;q=0.9,en;q=0.8',
  };

  const range = req.get('range');
  if (includeRange && range) headers.range = range;

  return headers;
}

async function cancelBody(body) {
  try {
    await body?.cancel?.();
  } catch {
    // ignore cleanup errors
  }
}

async function openUpstream(channel, req, controller, options = {}) {
  return fetch(channel.url, {
    headers: buildUpstreamHeaders(req, options),
    redirect: 'follow',
    signal: controller.signal,
  });
}

function shouldRetryWithoutRange(status) {
  return [400, 403, 404, 416, 458].includes(status);
}

function copyHeaders(upstream, res) {
  for (const [key, value] of upstream.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (PASS_THROUGH_HEADERS.has(lowerKey)) {
      res.setHeader(key, value);
    }
  }

  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', 'video/mp2t');
  }

  res.setHeader('x-accel-buffering', 'no');
}

async function waitForDrain(res) {
  if (res.destroyed || res.writableEnded) return;
  await once(res, 'drain');
}

async function pipeUpstream(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  res.on('close', () => {
    cancelBody(upstream.body);
  });

  try {
    while (!res.destroyed && !res.writableEnded) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!res.write(Buffer.from(value))) {
        await waitForDrain(res);
      }
    }

    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    if (!res.destroyed) res.destroy(error);
  }
}

export async function proxyStream(req, res) {
  const channel = await findChannel(req.params.id);

  if (!channel) {
    res.status(404).json({ error: 'Yayin bulunamadi' });
    return;
  }

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let upstream = await openUpstream(channel, req, controller, { includeRange: true });

  if (!upstream.ok && req.get('range') && shouldRetryWithoutRange(upstream.status)) {
    await cancelBody(upstream.body);
    upstream = await openUpstream(channel, req, controller, { includeRange: false });
  }

  if (!upstream.ok) {
    await cancelBody(upstream.body);

    if (!res.headersSent) {
      res.status(upstream.status === 458 ? 502 : upstream.status).json({
        error: `Yayin kaynagi acilamadi: HTTP ${upstream.status}`,
      });
    }

    return;
  }

  res.status(upstream.status);
  copyHeaders(upstream, res);
  await pipeUpstream(upstream, res);
}
