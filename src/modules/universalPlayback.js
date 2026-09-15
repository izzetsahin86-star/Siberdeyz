import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { findChannel } from './playlistService.js';
import { proxyStream } from './streamProxy.js';
import { getTenantId } from './tenantContext.js';

const HLS_RESOURCE_TTL_MS = 15 * 60 * 1000;
const TRANSCODE_IDLE_MS = 2 * 60 * 1000;
const MAX_TRANSCODE_SESSIONS = 2;
const TRANSCODE_ROOT = path.join(os.tmpdir(), 'siberdeyz-universal-player');

const hlsResources = new Map();
const sessionsByChannel = new Map();
const sessionsById = new Map();

function extensionOf(value) {
  try {
    const pathname = new URL(String(value || '')).pathname.toLocaleLowerCase('tr-TR');
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function classifyChannel(channel) {
  const extension = extensionOf(channel?.url);

  if (extension === 'm3u8') return 'hls';
  if (['mp4', 'mov', 'm4v', '3gp', '3g2'].includes(extension)) return 'native';
  return 'transcode';
}

function upstreamHeaders(req) {
  const headers = {
    'user-agent': req.get('user-agent') || 'Siberdeyz-IPTV-Player/1.0',
    accept: '*/*',
  };

  const range = req.get('range');
  if (range) headers.range = range;

  return headers;
}

function copyMediaHeaders(upstream, res) {
  for (const [key, value] of upstream.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(lowerKey)) {
      res.setHeader(key, value);
    }
  }
}

async function pipeBody(upstream, res) {
  if (!upstream.body) {
    res.end();
    return;
  }

  const reader = upstream.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (error) {
    res.destroy(error);
  }
}

function cleanupHlsResources() {
  const now = Date.now();

  for (const [token, entry] of hlsResources.entries()) {
    if (entry.expiresAt <= now) hlsResources.delete(token);
  }
}

function rememberHlsResource(url) {
  cleanupHlsResources();

  const token = crypto.randomBytes(18).toString('hex');
  hlsResources.set(token, {
    url,
    tenantId: getTenantId(),
    expiresAt: Date.now() + HLS_RESOURCE_TTL_MS,
  });

  return token;
}

function localizeHlsUri(value, baseUrl) {
  try {
    const absolute = new URL(value, baseUrl).toString();
    const token = rememberHlsResource(absolute);
    return `/api/media/hls/${token}`;
  } catch {
    return value;
  }
}

function rewriteUpstreamManifest(text, baseUrl) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (!trimmed.startsWith('#')) {
        return localizeHlsUri(trimmed, baseUrl);
      }

      return line.replace(/URI="([^"]+)"/g, (full, uri) => {
        if (/^(data:|blob:)/i.test(uri)) return full;
        return `URI="${localizeHlsUri(uri, baseUrl)}"`;
      });
    })
    .join('\n');
}

async function proxyHlsUrl(url, req, res) {
  const upstream = await fetch(url, {
    headers: upstreamHeaders(req),
    redirect: 'follow',
  });

  const finalUrl = upstream.url || url;
  const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
  const isManifest = contentType.includes('mpegurl') || /\.m3u8(?:$|[?#])/i.test(finalUrl);

  if (upstream.ok && isManifest) {
    const manifest = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', 'application/vnd.apple.mpegurl');
    res.setHeader('cache-control', 'no-store');
    res.send(rewriteUpstreamManifest(manifest, finalUrl));
    return;
  }

  res.status(upstream.status);
  copyMediaHeaders(upstream, res);

  if (!res.getHeader('content-type')) {
    res.setHeader('content-type', 'video/mp2t');
  }

  await pipeBody(upstream, res);
}

function isVodExtension(extension) {
  return ['mkv', 'avi', 'flv', 'webm', 'wmv', 'mpeg', 'mpg', 'vob', 'ogv', 'asf', 'rmvb'].includes(extension);
}

function ffmpegArgs(channel, userAgent, outputPath, segmentPattern) {
  const extension = extensionOf(channel.url);
  const vod = isVodExtension(extension);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
  ];

  if (!vod) {
    args.push(
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '2',
    );
  }

  args.push(
    '-user_agent', userAgent,
    '-i', channel.url,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-sn',
    '-dn',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'main',
    '-pix_fmt', 'yuv420p',
    '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*3)',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ac', '2',
    '-ar', '48000',
    '-max_muxing_queue_size', '1024',
    '-f', 'hls',
    '-hls_time', vod ? '4' : '3',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', segmentPattern,
  );

  if (vod) {
    args.push(
      '-hls_list_size', '0',
      '-hls_playlist_type', 'event',
      '-hls_flags', 'independent_segments',
    );
  } else {
    args.push(
      '-hls_list_size', '8',
      '-hls_flags', 'delete_segments+append_list+independent_segments',
    );
  }

  args.push(outputPath);
  return args;
}

async function waitForPlaylist(session, timeoutMs = 12000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const stat = await fsp.stat(session.playlistPath);
      if (stat.size > 20) return;
    } catch {
      // Playlist henuz olusmadi.
    }

    if (session.exited) {
      throw new Error(session.lastError || 'Uyumluluk oynaticisi baslatilamadi.');
    }

    await new Promise((resolve) => setTimeout(resolve, 180));
  }

  throw new Error('Uyumluluk oynaticisi zamaninda hazirlanamadi.');
}

async function removeSession(session) {
  if (!session) return;

  sessionsByChannel.delete(session.channelKey);
  sessionsById.delete(session.id);

  if (session.process && !session.exited) {
    session.process.kill('SIGTERM');
  }

  try {
    await fsp.rm(session.dir, { recursive: true, force: true });
  } catch {
    // Gecici dosya temizligi kritik degil.
  }
}

async function cleanupSessions() {
  const now = Date.now();

  for (const session of sessionsById.values()) {
    if (now - session.lastAccess > TRANSCODE_IDLE_MS) {
      await removeSession(session);
    }
  }
}

async function getOrStartSession(channel, req) {
  await cleanupSessions();

  const tenantId = getTenantId();
  const channelKey = tenantId + ':' + String(channel.id);
  const existing = sessionsByChannel.get(channelKey);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  if (sessionsById.size >= MAX_TRANSCODE_SESSIONS) {
    const oldest = Array.from(sessionsById.values())
      .sort((a, b) => a.lastAccess - b.lastAccess)[0];

    await removeSession(oldest);
  }

  await fsp.mkdir(TRANSCODE_ROOT, { recursive: true });

  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join(TRANSCODE_ROOT, id);
  await fsp.mkdir(dir, { recursive: true });

  const playlistPath = path.join(dir, 'index.m3u8');
  const segmentPattern = path.join(dir, 'segment_%06d.ts');
  const userAgent = req.get('user-agent') || 'Siberdeyz-IPTV-Player/1.0';

  const process = spawn('ffmpeg', ffmpegArgs(channel, userAgent, playlistPath, segmentPattern), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  const session = {
    id,
    tenantId,
    channelId: String(channel.id),
    channelKey,
    dir,
    playlistPath,
    process,
    exited: false,
    exitCode: null,
    lastError: '',
    lastAccess: Date.now(),
  };

  sessionsByChannel.set(session.channelKey, session);
  sessionsById.set(id, session);

  process.stderr.on('data', (chunk) => {
    const next = (session.lastError + chunk.toString()).slice(-3000);
    session.lastError = next;
  });

  process.on('exit', (code) => {
    session.exited = true;
    session.exitCode = code;
  });

  process.on('error', (error) => {
    session.exited = true;
    session.lastError = error.message;
  });

  return session;
}

function rewriteLocalManifest(text, session) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (/^segment_\d+\.ts$/i.test(trimmed)) {
        return `/api/media/transcode/${session.id}/${trimmed}`;
      }
      return line;
    })
    .join('\n');
}

async function serveTranscodedManifest(req, res, channel) {
  const session = await getOrStartSession(channel, req);
  session.lastAccess = Date.now();

  await waitForPlaylist(session);

  const manifest = await fsp.readFile(session.playlistPath, 'utf-8');
  res.setHeader('content-type', 'application/vnd.apple.mpegurl');
  res.setHeader('cache-control', 'no-store');
  res.send(rewriteLocalManifest(manifest, session));
}

export async function playUniversal(req, res) {
  const channel = await findChannel(req.params.id);

  if (!channel) {
    res.status(404).json({ error: 'Yayin bulunamadi' });
    return;
  }

  const kind = classifyChannel(channel);

  if (kind === 'hls') {
    await proxyHlsUrl(channel.url, req, res);
    return;
  }

  if (kind === 'native') {
    await proxyStream(req, res);
    return;
  }

  try {
    await serveTranscodedManifest(req, res, channel);
  } catch (error) {
    if (res.headersSent) throw error;
    await proxyStream(req, res);
  }
}

export async function playHlsResource(req, res) {
  cleanupHlsResources();

  const entry = hlsResources.get(String(req.params.token || ''));
  if (!entry || entry.tenantId !== getTenantId() || entry.expiresAt <= Date.now()) {
    res.status(404).json({ error: 'HLS kaynagi bulunamadi veya suresi doldu' });
    return;
  }

  entry.expiresAt = Date.now() + HLS_RESOURCE_TTL_MS;
  await proxyHlsUrl(entry.url, req, res);
}

export async function playTranscodedResource(req, res) {
  const session = sessionsById.get(String(req.params.session || ''));
  const file = String(req.params.file || '');

  if (!session || session.tenantId !== getTenantId() || !/^segment_\d+\.ts$/i.test(file)) {
    res.status(404).end();
    return;
  }

  session.lastAccess = Date.now();

  const filePath = path.join(session.dir, file);
  if (!fs.existsSync(filePath)) {
    res.status(404).end();
    return;
  }

  res.type('video/mp2t');
  res.sendFile(filePath);
}
