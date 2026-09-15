import crypto from 'crypto';
import dns from 'dns/promises';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import puppeteer from 'puppeteer-core';
import { getTenantDataDir, getTenantId } from './tenantContext.js';
import { saveWebScanPlaylistSource } from './sourceStorage.js';

const MIN_DURATION_SECONDS = 180;
const MAX_CANDIDATES = 40;
const MAX_VISIBLE_RESULTS = 30;
const PAGE_TIMEOUT_MS = 18000;
const DISCOVERY_WAIT_MS = 4500;
const PROBE_TIMEOUT_MS = 12000;
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 Siberdeyz-Web-Scanner/1.0';
const MEDIA_EXTENSIONS = new Set(['m3u8', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mpd']);
const activeScans = new Set();

function getPendingFile() {
  return path.join(getTenantDataDir(), 'web-scan-pending.json');
}

function getChromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || '/usr/bin/chromium';
}

function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address) {
  const value = String(address || '').toLowerCase();
  if (!value || value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('ff')) return true;

  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

function isPrivateIp(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

async function assertPublicHttpUrl(value) {
  let parsed;

  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    const error = new Error('Gecerli bir web sitesi adresi girin.');
    error.status = 400;
    throw error;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('Yalnizca http veya https adresleri taranabilir.');
    error.status = 400;
    throw error;
  }

  if (parsed.username || parsed.password) {
    const error = new Error('Kullanici adi veya sifre iceren URL taranamaz.');
    error.status = 400;
    throw error;
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === 'metadata.google.internal'
  ) {
    const error = new Error('Yerel veya ozel ag adresleri taranamaz.');
    error.status = 400;
    throw error;
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      const error = new Error('Yerel veya ozel IP adresleri taranamaz.');
      error.status = 400;
      throw error;
    }
    return parsed;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    const error = new Error('Web sitesinin adresi cozumlenemedi.');
    error.status = 400;
    throw error;
  }

  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    const error = new Error('Yerel veya ozel ag hedefleri taranamaz.');
    error.status = 400;
    throw error;
  }

  return parsed;
}

function extensionOf(value) {
  try {
    const pathname = new URL(value).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function looksLikeMediaUrl(value) {
  const extension = extensionOf(value);
  return MEDIA_EXTENSIONS.has(extension);
}

function isMediaContentType(value) {
  const type = String(value || '').toLowerCase();
  return (
    type.startsWith('video/')
    || type.startsWith('audio/')
    || type.includes('mpegurl')
    || type.includes('dash+xml')
  );
}

function safeNameFromUrl(value, fallbackIndex) {
  try {
    const parsed = new URL(value);
    const raw = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const cleaned = raw.replace(/\.(m3u8|mp4|m4v|mov|webm|mkv|mpd)$/i, '').replace(/[_-]+/g, ' ').trim();
    return cleaned && cleaned.toLowerCase() !== 'index'
      ? cleaned.slice(0, 100)
      : ('Web Yayin ' + fallbackIndex);
  } catch {
    return 'Web Yayin ' + fallbackIndex;
  }
}

function candidateId(url) {
  return 'web_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function formatKind(url) {
  const extension = extensionOf(url);
  if (extension === 'm3u8') return 'HLS';
  if (extension === 'mpd') return 'DASH';
  return extension ? extension.toUpperCase() : 'VIDEO';
}

async function safeFetch(url, options = {}, redirectsLeft = 4) {
  const parsed = await assertPublicHttpUrl(url);
  const response = await fetch(parsed, {
    ...options,
    redirect: 'manual',
    headers: {
      'user-agent': USER_AGENT,
      accept: '*/*',
      ...(options.headers || {}),
    },
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location || redirectsLeft <= 0) throw new Error('Cok fazla yonlendirme var.');
    const next = new URL(location, parsed).toString();
    return safeFetch(next, options, redirectsLeft - 1);
  }

  return response;
}

async function readTextLimited(response, maxBytes = 700000) {
  if (!response.body?.getReader) return (await response.text()).slice(0, maxBytes);

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

  return Buffer.concat(chunks).toString('utf-8');
}

async function probeHls(url, depth = 0) {
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: {
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
    },
  });

  if (!response.ok) throw new Error('HTTP ' + response.status);

  const text = await readTextLimited(response);
  if (!text.includes('#EXTM3U')) throw new Error('Gecerli HLS listesi degil.');

  if (depth < 2 && text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].trim().startsWith('#EXT-X-STREAM-INF')) continue;
      const next = lines.slice(index + 1).find((line) => line.trim() && !line.trim().startsWith('#'));
      if (next) return probeHls(new URL(next.trim(), response.url || url).toString(), depth + 1);
    }
  }

  const durations = [...text.matchAll(/#EXTINF:([0-9.]+)/gi)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 0);

  const isEnded = /#EXT-X-ENDLIST/i.test(text);
  const total = durations.reduce((sum, value) => sum + value, 0);

  return {
    playable: true,
    durationSeconds: isEnded && total > 0 ? total : null,
    live: !isEnded,
  };
}

function ffprobe(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-rw_timeout', String(PROBE_TIMEOUT_MS * 1000),
      '-user_agent', USER_AGENT,
      '-show_entries', 'format=duration,format_name',
      '-of', 'json',
      url,
    ];

    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
    }, PROBE_TIMEOUT_MS + 1500);

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-200000);
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-3000);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;

      if (code !== 0) {
        reject(new Error(stderr || 'Medya acilamadi.'));
        return;
      }

      try {
        const data = JSON.parse(stdout || '{}');
        const duration = Number(data?.format?.duration);
        resolve({
          playable: true,
          durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
          live: !Number.isFinite(duration) || duration <= 0,
        });
      } catch {
        resolve({ playable: true, durationSeconds: null, live: true });
      }
    });
  });
}

async function probeCandidate(url) {
  await assertPublicHttpUrl(url);
  if (extensionOf(url) === 'm3u8') {
    try {
      return await probeHls(url);
    } catch {
      return ffprobe(url);
    }
  }

  return ffprobe(url);
}

function makeCandidate(url, index, discoveredBy) {
  return {
    id: candidateId(url),
    name: safeNameFromUrl(url, index),
    url,
    kind: formatKind(url),
    discoveredBy,
  };
}

function extractMediaUrlsFromText(text, baseUrl) {
  const found = new Set();
  const normalized = String(text || '').replace(/\\\//g, '/');

  const absolutePattern = /https?:\/\/[^"'<>\\s]+?\.(?:m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:\?[^"'<>\\s]*)?/gi;
  for (const match of normalized.matchAll(absolutePattern)) {
    try {
      found.add(new URL(match[0], baseUrl).toString());
    } catch {
      // Gecersiz URL yok sayilir.
    }
  }

  const relativePattern = /(?:src|href|file|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:\?[^"']*)?)["']/gi;
  for (const match of normalized.matchAll(relativePattern)) {
    try {
      found.add(new URL(match[1], baseUrl).toString());
    } catch {
      // Gecersiz URL yok sayilir.
    }
  }

  return [...found].slice(0, MAX_CANDIDATES);
}

async function discoverStatically(pageUrl) {
  const response = await safeFetch(pageUrl, {
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain,*/*',
    },
  });

  if (!response.ok) throw new Error('Web sayfasi acilamadi: HTTP ' + response.status);
  const text = await readTextLimited(response, 2500000);
  const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch
    ? titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    : '';

  return {
    pageTitle,
    candidates: extractMediaUrlsFromText(text, response.url || pageUrl)
      .map((url, index) => makeCandidate(url, index + 1, 'html')),
  };
}

async function discoverWithBrowser(pageUrl) {
  const browser = await puppeteer.launch({
    executablePath: getChromiumPath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-networking',
    ],
  });

  const found = new Map();
  const hostSafety = new Map();

  const addCandidate = (value, discoveredBy = 'network') => {
    try {
      const absolute = new URL(String(value || ''), pageUrl).toString();
      if (!absolute.startsWith('http://') && !absolute.startsWith('https://')) return;
      if (!looksLikeMediaUrl(absolute) && discoveredBy !== 'response') return;
      if (!found.has(absolute) && found.size < MAX_CANDIDATES) {
        found.set(absolute, discoveredBy);
      }
    } catch {
      // Gecersiz aday yok sayilir.
    }
  };

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(USER_AGENT);
    await page.setRequestInterception(true);

    page.on('request', async (request) => {
      const url = request.url();
      const resourceType = request.resourceType();

      if (url.startsWith('data:') || url.startsWith('blob:')) {
        request.continue().catch(() => {});
        return;
      }

      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        request.abort().catch(() => {});
        return;
      }

      if (looksLikeMediaUrl(url)) addCandidate(url, 'request');

      if (resourceType === 'image' || resourceType === 'font') {
        request.abort().catch(() => {});
        return;
      }

      try {
        const host = new URL(url).hostname;
        if (!hostSafety.has(host)) {
          hostSafety.set(host, assertPublicHttpUrl(url).then(() => true).catch(() => false));
        }

        const safe = await hostSafety.get(host);
        if (safe) request.continue().catch(() => {});
        else request.abort().catch(() => {});
      } catch {
        request.abort().catch(() => {});
      }
    });

    page.on('response', (response) => {
      const contentType = response.headers()['content-type'] || '';
      const url = response.url();
      if (looksLikeMediaUrl(url) || isMediaContentType(contentType)) {
        addCandidate(url, 'response');
      }
    });

    await page.goto(pageUrl, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    const pageTitle = String(await page.title().catch(() => '')).trim();

    const domUrls = await page.evaluate(() => {
      const values = new Set();
      document.querySelectorAll('video,audio,source,a').forEach((element) => {
        const candidates = [
          element.currentSrc,
          element.src,
          element.href,
          element.getAttribute?.('src'),
          element.getAttribute?.('href'),
        ];

        candidates.filter(Boolean).forEach((value) => values.add(String(value)));
      });

      document.querySelectorAll('video,audio').forEach((media) => {
        try {
          media.muted = true;
          media.play().catch(() => {});
        } catch {
          // Otomatik oynatma desteklenmeyebilir.
        }
      });

      window.scrollTo(0, Math.min(document.body?.scrollHeight || 0, 2400));
      return [...values];
    }).catch(() => []);

    for (const value of domUrls) addCandidate(value, 'dom');

    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_WAIT_MS));

    const renderedUrls = await page.evaluate(() => {
      const values = new Set();
      document.querySelectorAll('video,audio,source').forEach((element) => {
        [element.currentSrc, element.src, element.getAttribute?.('src')]
          .filter(Boolean)
          .forEach((value) => values.add(String(value)));
      });
      return [...values];
    }).catch(() => []);

    for (const value of renderedUrls) addCandidate(value, 'dom');

    return {
      pageTitle,
      candidates: [...found.entries()].map(([url, discoveredBy], index) => (
        makeCandidate(url, index + 1, discoveredBy)
      )),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function writePending(value) {
  await fs.mkdir(getTenantDataDir(), { recursive: true });
  const target = getPendingFile();
  const temp = target + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2));
  await fs.rename(temp, target);
}

async function readPending() {
  try {
    const value = JSON.parse(await fs.readFile(getPendingFile(), 'utf-8'));
    if (!value?.createdAt || Date.now() - Date.parse(value.createdAt) > PENDING_TTL_MS) return null;
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

export async function scanWebPage(rawUrl) {
  const tenantId = getTenantId();
  if (activeScans.has(tenantId)) {
    const error = new Error('Bu kullanici icin zaten bir web taramasi calisiyor.');
    error.status = 409;
    throw error;
  }

  activeScans.add(tenantId);

  try {
    const pageUrl = (await assertPublicHttpUrl(rawUrl)).toString();

    let browserDiscovery = { pageTitle: '', candidates: [] };
    let staticDiscovery = { pageTitle: '', candidates: [] };

    try {
      browserDiscovery = await discoverWithBrowser(pageUrl);
    } catch {
      // Bazi siteler headless tarayiciyi engelleyebilir; statik motor devam eder.
    }

    try {
      staticDiscovery = await discoverStatically(pageUrl);
    } catch {
      // Tarayici motoru sonuc verdiyse statik motor hatasi kritik degildir.
    }

    const merged = new Map();
    for (const candidate of [...browserDiscovery.candidates, ...staticDiscovery.candidates]) {
      if (!merged.has(candidate.url) && merged.size < MAX_CANDIDATES) {
        merged.set(candidate.url, candidate);
      }
    }

    if (merged.size === 0) {
      const error = new Error('Bu sayfada erisilebilir video veya yayin kaynagi bulunamadi.');
      error.status = 404;
      throw error;
    }

    const discovery = {
      pageTitle: browserDiscovery.pageTitle || staticDiscovery.pageTitle || '',
      candidates: [...merged.values()],
    };
    const detected = discovery.candidates.slice(0, MAX_CANDIDATES);

    const probed = await mapWithConcurrency(detected, 4, async (candidate) => {
      try {
        const result = await probeCandidate(candidate.url);
        return { ...candidate, ...result, error: '' };
      } catch (error) {
        return {
          ...candidate,
          playable: false,
          durationSeconds: null,
          live: false,
          error: String(error?.message || 'Yayin acilamadi.').slice(0, 220),
        };
      }
    });

    const playable = probed.filter((item) => item.playable);
    const shortRemoved = playable.filter((item) => (
      Number.isFinite(item.durationSeconds) && item.durationSeconds < MIN_DURATION_SECONDS
    ));
    const visible = playable
      .filter((item) => !Number.isFinite(item.durationSeconds) || item.durationSeconds >= MIN_DURATION_SECONDS)
      .slice(0, MAX_VISIBLE_RESULTS)
      .map((item) => ({
        ...item,
        durationStatus: Number.isFinite(item.durationSeconds) ? 'known' : 'unknown',
      }));

    const scan = {
      scanId: 'scan_' + crypto.randomBytes(12).toString('hex'),
      pageUrl,
      pageTitle: discovery.pageTitle || new URL(pageUrl).hostname,
      createdAt: new Date().toISOString(),
      candidates: visible,
      summary: {
        detected: detected.length,
        tested: probed.length,
        accepted: visible.length,
        shortRemoved: shortRemoved.length,
        failed: probed.filter((item) => !item.playable).length,
        unknownDuration: visible.filter((item) => item.durationStatus === 'unknown').length,
      },
    };

    await writePending(scan);
    return scan;
  } finally {
    activeScans.delete(tenantId);
  }
}

export async function saveWebScanSelection(scanId, candidateIds = [], label = '') {
  const pending = await readPending();

  if (!pending || pending.scanId !== String(scanId || '')) {
    const error = new Error('Tarama sonucu bulunamadi veya suresi doldu. Yeniden tarayin.');
    error.status = 404;
    throw error;
  }

  const ids = new Set(
    (Array.isArray(candidateIds) ? candidateIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  const selected = pending.candidates.filter((candidate) => ids.has(candidate.id));

  if (selected.length === 0) {
    const error = new Error('Kaydedilecek en az bir yayin secin.');
    error.status = 400;
    throw error;
  }

  const sourceLabel = String(label || '').trim()
    || ('Web Tarama · ' + new URL(pending.pageUrl).hostname);

  const status = await saveWebScanPlaylistSource({
    label: sourceLabel,
    pageUrl: pending.pageUrl,
    channels: selected.map((candidate, index) => ({
      name: candidate.name || ('Web Yayin ' + (index + 1)),
      group: 'Web Tarama',
      url: candidate.url,
      webDurationSeconds: Number.isFinite(candidate.durationSeconds) ? candidate.durationSeconds : null,
      webDurationStatus: candidate.durationStatus,
    })),
  });

  return {
    ...status,
    saved: selected.length,
    folder: 'Web Tarama',
    sourceLabel,
  };
}
