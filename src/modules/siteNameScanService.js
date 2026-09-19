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
const DEFAULT_PAGE_LIMIT = 60;
const MAX_PAGE_LIMIT = 120;
const MAX_MATCH_PAGES = 12;
const MAX_MEDIA_CANDIDATES = 120;
const MAX_RESULTS = 80;
const PAGE_TIMEOUT_MS = 12000;
const BROWSER_TIMEOUT_MS = 14000;
const BROWSER_SETTLE_MS = 2600;
const PROBE_TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 1800000;
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 Siberdeyz-Name-Scanner/1.0';
const MEDIA_EXTENSIONS = new Set(['m3u8', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mpd']);
const ACTIVE_STATUSES = new Set(['running', 'paused', 'stopping']);
const jobs = new Map();

function jobFile() {
  return path.join(getTenantDataDir(), 'site-name-scan-job.json');
}

function getChromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || '/usr/bin/chromium';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
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
  const input = String(value || '').trim();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : ('https://' + input.replace(/^\/+/, ''));

  let parsed;
  try {
    parsed = new URL(normalized);
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
    return safeFetch(new URL(location, parsed).toString(), options, redirectsLeft - 1);
  }

  return response;
}

async function readTextLimited(response, maxBytes = MAX_BODY_BYTES) {
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

function normalizePageUrl(value) {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function rootHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^(?:www|m)\./, '');
}

function isSameSite(root, candidate) {
  const a = rootHost(root);
  const b = rootHost(candidate);
  return b === a || b.endsWith('.' + a);
}

function shouldVisitPage(url) {
  try {
    const parsed = new URL(url);
    return !/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|pdf|zip|rar|7z|gz|mp3|wav|m4a|m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:$|\?)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function pageTitleFromHtml(html) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]).slice(0, 180) : '';
}

function extractLinks(html, baseUrl, siteHost) {
  const found = new Set();
  const pattern = /\bhref\s*=\s*["']([^"'#]+)["']/gi;

  for (const match of String(html || '').matchAll(pattern)) {
    try {
      const absolute = normalizePageUrl(new URL(match[1].trim(), baseUrl).toString());
      if (!absolute) continue;
      const parsed = new URL(absolute);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (!isSameSite(siteHost, parsed.hostname)) continue;
      if (!shouldVisitPage(absolute)) continue;
      found.add(absolute);
    } catch {
      // Gecersiz link yok sayilir.
    }
  }

  return [...found];
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
  return MEDIA_EXTENSIONS.has(extensionOf(value));
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

function extractMediaUrlsFromText(text, baseUrl) {
  const found = new Set();
  const normalized = String(text || '').replace(/\\\//g, '/');

  const absolutePattern = /https?:\/\/[^"'<>\\s]+?\.(?:m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:\?[^"'<>\\s]*)?/gi;
  for (const match of normalized.matchAll(absolutePattern)) {
    try {
      found.add(new URL(match[0], baseUrl).toString());
    } catch {
      // ignore
    }
  }

  const relativePattern = /(?:src|href|file|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:\?[^"']*)?)["']/gi;
  for (const match of normalized.matchAll(relativePattern)) {
    try {
      found.add(new URL(match[1], baseUrl).toString());
    } catch {
      // ignore
    }
  }

  return [...found];
}

function mediaId(url) {
  return 'name_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function mediaKind(url) {
  const ext = extensionOf(url);
  if (ext === 'm3u8') return 'HLS';
  if (ext === 'mpd') return 'DASH';
  return ext ? ext.toUpperCase() : 'VIDEO';
}

function safeMediaName(url, fallbackIndex, title = '') {
  const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
  if (cleanTitle && !/^(please wait|just a moment|loading)$/i.test(cleanTitle)) {
    return cleanTitle.slice(0, 120);
  }

  try {
    const parsed = new URL(url);
    const raw = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const cleaned = raw
      .replace(/\.(m3u8|mp4|m4v|mov|webm|mkv|mpd)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim();

    return cleaned && cleaned.toLowerCase() !== 'index'
      ? cleaned.slice(0, 100)
      : ('Isim Tarama Yayini ' + fallbackIndex);
  } catch {
    return 'Isim Tarama Yayini ' + fallbackIndex;
  }
}

async function probeHls(url, depth = 0) {
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: {
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,text/plain,*/*',
    },
  });

  if (!response.ok) throw new Error('HTTP ' + response.status);
  const text = await readTextLimited(response, 700000);
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

  const ended = /#EXT-X-ENDLIST/i.test(text);
  const total = durations.reduce((sum, value) => sum + value, 0);

  return {
    playable: true,
    durationSeconds: ended && total > 0 ? total : null,
    live: !ended,
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
      if (!finished) child.kill('SIGKILL');
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

async function writeJob(job) {
  await fs.mkdir(getTenantDataDir(), { recursive: true });
  const target = jobFile();
  const temp = target + '.tmp';
  await fs.writeFile(temp, JSON.stringify(job, null, 2));
  await fs.rename(temp, target);
}

async function readStoredJob() {
  try {
    return JSON.parse(await fs.readFile(jobFile(), 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function snapshot(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    status: job.status,
    phase: job.phase,
    siteUrl: job.siteUrl,
    query: job.query,
    pageLimit: job.pageLimit,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    message: job.message,
    progress: { ...(job.progress || {}) },
    matches: Array.isArray(job.matches) ? job.matches : [],
    results: Array.isArray(job.results) ? job.results : [],
  };
}

async function persist(job) {
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
}

function currentJob() {
  return jobs.get(getTenantId()) || null;
}

async function waitIfPaused(job) {
  while (job.status === 'paused') {
    await delay(350);
  }
  return job.status !== 'stopping';
}

function addMediaCandidate(found, value, meta = {}) {
  try {
    const url = new URL(String(value || ''), meta.sourcePage || undefined).toString();
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;
    if (!looksLikeMediaUrl(url) && !meta.allowUnknown) return;
    if (!found.has(url) && found.size < MAX_MEDIA_CANDIDATES) {
      found.set(url, {
        url,
        title: String(meta.title || '').slice(0, 180),
        sourcePage: String(meta.sourcePage || '').slice(0, 700),
        discoveredBy: String(meta.discoveredBy || 'network'),
      });
    }
  } catch {
    // ignore
  }
}

async function scanMatchedPages(job, matchedPages) {
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
      '--disable-popup-blocking',
    ],
  });

  const found = new Map();

  try {
    for (const match of matchedPages) {
      if (!(await waitIfPaused(job))) break;

      const page = await browser.newPage();
      const responseTasks = [];
      let currentTitle = match.title || '';

      try {
        await page.setViewport({ width: 1280, height: 900 });
        await page.setUserAgent(USER_AGENT);
        await page.setBypassCSP(true);
        await page.setRequestInterception(true);

        page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));

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

          if (looksLikeMediaUrl(url)) {
            addMediaCandidate(found, url, {
              title: currentTitle,
              sourcePage: match.url,
              discoveredBy: 'request',
            });
          }

          if (resourceType === 'image' || resourceType === 'font') {
            request.abort().catch(() => {});
            return;
          }

          try {
            await assertPublicHttpUrl(url);
            request.continue().catch(() => {});
          } catch {
            request.abort().catch(() => {});
          }
        });

        page.on('response', (response) => {
          const headers = response.headers();
          const contentType = String(headers['content-type'] || '').toLowerCase();
          const url = response.url();
          const resourceType = response.request().resourceType();

          if (looksLikeMediaUrl(url) || isMediaContentType(contentType)) {
            addMediaCandidate(found, url, {
              title: currentTitle,
              sourcePage: match.url,
              discoveredBy: 'response',
              allowUnknown: isMediaContentType(contentType),
            });
          }

          const inspectBody = ['xhr', 'fetch', 'script'].includes(resourceType)
            && (contentType.includes('json') || contentType.includes('javascript') || contentType.startsWith('text/'));

          if (!inspectBody || responseTasks.length >= 24) return;

          responseTasks.push(
            response.text()
              .then((body) => {
                if (!body || body.length > 2500000) return;
                for (const mediaUrl of extractMediaUrlsFromText(body, response.url())) {
                  addMediaCandidate(found, mediaUrl, {
                    title: currentTitle,
                    sourcePage: match.url,
                    discoveredBy: 'xhr-body',
                  });
                }
              })
              .catch(() => {})
          );
        });

        await page.goto(match.url, {
          waitUntil: 'domcontentloaded',
          timeout: BROWSER_TIMEOUT_MS,
        });

        currentTitle = String(await page.title().catch(() => currentTitle)).trim() || currentTitle;

        const signals = await page.evaluate(() => {
          const media = new Set();

          document.querySelectorAll('video,audio,source').forEach((element) => {
            [
              element.currentSrc,
              element.src,
              element.getAttribute?.('src'),
              element.getAttribute?.('data-src'),
              element.getAttribute?.('data-file'),
            ].filter(Boolean).forEach((value) => media.add(String(value)));
          });

          const playSelectors = [
            '.vjs-big-play-button',
            '.jw-icon-playback',
            '.plyr__control--overlaid',
            '[data-plyr="play"]',
            'button[aria-label*="play" i]',
            '[role="button"][aria-label*="play" i]',
            'button[title*="play" i]',
          ];

          let clicked = 0;
          for (const selector of playSelectors) {
            for (const element of document.querySelectorAll(selector)) {
              if (clicked >= 3) break;
              try {
                element.click();
                clicked += 1;
              } catch {
                // ignore
              }
            }
            if (clicked >= 3) break;
          }

          document.querySelectorAll('video,audio').forEach((mediaElement) => {
            try {
              mediaElement.muted = true;
              mediaElement.preload = 'auto';
              mediaElement.play().catch(() => {});
            } catch {
              // ignore
            }
          });

          return [...media];
        }).catch(() => []);

        for (const value of signals) {
          addMediaCandidate(found, value, {
            title: currentTitle,
            sourcePage: match.url,
            discoveredBy: 'dom',
          });
        }

        await delay(BROWSER_SETTLE_MS);

        const lateSignals = await page.evaluate(() => {
          const values = new Set();
          for (const entry of performance.getEntriesByType('resource')) {
            if (entry?.name) values.add(String(entry.name));
          }
          document.querySelectorAll('video,audio,source').forEach((element) => {
            [element.currentSrc, element.src, element.getAttribute?.('src')]
              .filter(Boolean)
              .forEach((value) => values.add(String(value)));
          });
          return [...values];
        }).catch(() => []);

        for (const value of lateSignals) {
          if (looksLikeMediaUrl(value)) {
            addMediaCandidate(found, value, {
              title: currentTitle,
              sourcePage: match.url,
              discoveredBy: 'performance',
            });
          }
        }

        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const frameMedia = await frame.evaluate(() => {
            const values = new Set();
            document.querySelectorAll('video,audio,source').forEach((element) => {
              [element.currentSrc, element.src, element.getAttribute?.('src')]
                .filter(Boolean)
                .forEach((value) => values.add(String(value)));
            });
            return [...values];
          }).catch(() => []);

          for (const value of frameMedia) {
            addMediaCandidate(found, value, {
              title: currentTitle,
              sourcePage: match.url,
              discoveredBy: 'iframe',
            });
          }
        }

        await Promise.allSettled(responseTasks);
      } catch {
        job.progress.pageErrors += 1;
      } finally {
        await page.close().catch(() => {});
      }

      job.progress.matchPagesScanned += 1;
      job.progress.mediaFound = found.size;
      await persist(job);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return [...found.values()];
}

async function runJob(job) {
  try {
    const root = new URL(job.siteUrl);
    const siteHost = root.hostname;
    const queryKey = normalizeText(job.query);
    const queue = [normalizePageUrl(job.siteUrl)];
    const queued = new Set(queue);
    const visited = new Set();
    const matches = [];

    job.phase = 'searching';
    job.message = 'Site icinde isim eslesmeleri araniyor...';
    await persist(job);

    while (queue.length > 0 && visited.size < job.pageLimit && matches.length < MAX_MATCH_PAGES) {
      if (!(await waitIfPaused(job))) break;

      const current = queue.shift();
      queued.delete(current);
      if (!current || visited.has(current)) continue;
      visited.add(current);

      job.progress.pagesVisited = visited.size;
      job.progress.pagesQueued = queue.length;
      await persist(job);

      try {
        const response = await safeFetch(current, {
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
          headers: { accept: 'text/html,application/xhtml+xml,*/*' },
        });

        if (!response.ok) {
          job.progress.pageErrors += 1;
          continue;
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        if (contentType && !contentType.includes('html') && !contentType.startsWith('text/')) continue;

        const html = await readTextLimited(response);
        const finalUrl = normalizePageUrl(response.url || current) || current;
        const title = pageTitleFromHtml(html);
        const visibleText = stripHtml(html).slice(0, 350000);
        const haystack = normalizeText(title + ' ' + visibleText + ' ' + finalUrl);

        if (queryKey && haystack.includes(queryKey)) {
          const exists = matches.some((item) => item.url === finalUrl);
          if (!exists) {
            matches.push({
              id: 'match_' + crypto.createHash('sha1').update(finalUrl).digest('hex').slice(0, 12),
              url: finalUrl,
              title: title || new URL(finalUrl).pathname || new URL(finalUrl).hostname,
            });
            job.matches = matches;
            job.progress.matchesFound = matches.length;
          }
        }

        for (const link of extractLinks(html, finalUrl, siteHost)) {
          if (visited.has(link) || queued.has(link)) continue;
          if (visited.size + queue.length >= job.pageLimit * 2) break;
          queue.push(link);
          queued.add(link);
        }

        job.progress.pagesQueued = queue.length;
      } catch {
        job.progress.pageErrors += 1;
      }
    }

    if (job.status === 'stopping') {
      job.status = 'stopped';
      job.phase = 'stopped';
      job.message = 'Isim taramasi durduruldu.';
      await persist(job);
      return;
    }

    if (matches.length === 0) {
      job.status = 'completed';
      job.phase = 'completed';
      job.message = '"' + job.query + '" icin eslesen sayfa bulunamadi.';
      await persist(job);
      return;
    }

    job.phase = 'discovering';
    job.message = matches.length + ' eslesen sayfa bulundu. Yayinlar araniyor...';
    await persist(job);

    const mediaCandidates = await scanMatchedPages(job, matches);

    if (job.status === 'stopping') {
      job.status = 'stopped';
      job.phase = 'stopped';
      job.message = 'Isim taramasi durduruldu.';
      await persist(job);
      return;
    }

    job.phase = 'testing';
    job.message = 'Bulunan yayinlar dogrulaniyor...';
    job.progress.mediaFound = mediaCandidates.length;
    await persist(job);

    const results = [];
    for (let index = 0; index < mediaCandidates.length; index += 1) {
      if (!(await waitIfPaused(job))) break;
      if (job.status === 'stopping') break;

      const candidate = mediaCandidates[index];
      try {
        const probe = await probeCandidate(candidate.url);
        job.progress.mediaTested += 1;

        if (Number.isFinite(probe.durationSeconds) && probe.durationSeconds < MIN_DURATION_SECONDS) {
          job.progress.shortRemoved += 1;
        } else if (results.length < MAX_RESULTS) {
          results.push({
            id: mediaId(candidate.url),
            name: safeMediaName(candidate.url, results.length + 1, candidate.title),
            url: candidate.url,
            kind: mediaKind(candidate.url),
            sourcePage: candidate.sourcePage,
            discoveredBy: candidate.discoveredBy,
            playable: true,
            live: Boolean(probe.live),
            durationSeconds: Number.isFinite(probe.durationSeconds) ? probe.durationSeconds : null,
            durationStatus: Number.isFinite(probe.durationSeconds) ? 'known' : 'unknown',
          });
          job.progress.accepted = results.length;
          job.results = results;
        }
      } catch {
        job.progress.mediaTested += 1;
        job.progress.mediaFailed += 1;
      }

      if (index % 2 === 0) await persist(job);
    }

    if (job.status === 'stopping') {
      job.status = 'stopped';
      job.phase = 'stopped';
      job.message = 'Isim taramasi durduruldu.';
    } else {
      job.status = 'completed';
      job.phase = 'completed';
      job.message = results.length > 0
        ? results.length + ' uygun yayin bulundu.'
        : 'Eslesen sayfalar bulundu ancak kaydedilebilir yayin bulunamadi.';
    }

    job.results = results;
    await persist(job);
  } catch (error) {
    job.status = 'failed';
    job.phase = 'failed';
    job.message = String(error?.message || 'Isim taramasi tamamlanamadi.').slice(0, 300);
    await persist(job).catch(() => {});
  } finally {
    jobs.delete(job.tenantId);
  }
}

export async function startSiteNameScan(rawUrl, rawQuery, rawLimit) {
  const tenantId = getTenantId();
  const active = jobs.get(tenantId);
  if (active && ACTIVE_STATUSES.has(active.status)) {
    const error = new Error('Bu kullanici icin zaten bir isim taramasi calisiyor.');
    error.status = 409;
    throw error;
  }

  const siteUrl = (await assertPublicHttpUrl(rawUrl)).toString();
  const query = String(rawQuery || '').replace(/\s+/g, ' ').trim();
  if (query.length < 2) {
    const error = new Error('Aranacak isim en az 2 karakter olmali.');
    error.status = 400;
    throw error;
  }

  const requestedLimit = Number(rawLimit);
  const pageLimit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_PAGE_LIMIT, Math.max(10, Math.floor(requestedLimit)))
    : DEFAULT_PAGE_LIMIT;

  const now = new Date().toISOString();
  const job = {
    tenantId,
    jobId: 'name_' + crypto.randomBytes(12).toString('hex'),
    status: 'running',
    phase: 'queued',
    siteUrl,
    query,
    pageLimit,
    createdAt: now,
    updatedAt: now,
    message: 'Isim taramasi baslatiliyor...',
    matches: [],
    results: [],
    progress: {
      pagesVisited: 0,
      pagesQueued: 1,
      matchesFound: 0,
      matchPagesScanned: 0,
      mediaFound: 0,
      mediaTested: 0,
      accepted: 0,
      shortRemoved: 0,
      mediaFailed: 0,
      pageErrors: 0,
    },
  };

  jobs.set(tenantId, job);
  await persist(job);
  setImmediate(() => {
    runJob(job).catch(() => {});
  });

  return snapshot(job);
}

export async function getSiteNameScanStatus() {
  const live = currentJob();
  if (live) return snapshot(live);
  return snapshot(await readStoredJob());
}

export async function pauseSiteNameScan() {
  const job = currentJob();
  if (!job || !ACTIVE_STATUSES.has(job.status)) {
    const error = new Error('Aktif isim taramasi bulunamadi.');
    error.status = 404;
    throw error;
  }

  job.status = 'paused';
  job.message = 'Isim taramasi duraklatildi.';
  await persist(job);
  return snapshot(job);
}

export async function resumeSiteNameScan() {
  const job = currentJob();
  if (!job || job.status !== 'paused') {
    const error = new Error('Duraklatilmis isim taramasi bulunamadi.');
    error.status = 404;
    throw error;
  }

  job.status = 'running';
  job.message = 'Isim taramasina devam ediliyor...';
  await persist(job);
  return snapshot(job);
}

export async function stopSiteNameScan() {
  const job = currentJob();
  if (!job || !ACTIVE_STATUSES.has(job.status)) {
    const stored = await readStoredJob();
    return snapshot(stored);
  }

  job.status = 'stopping';
  job.message = 'Isim taramasi durduruluyor...';
  await persist(job);
  return snapshot(job);
}

export async function saveSiteNameScanSelection(jobId, candidateIds = [], label = '') {
  const stored = currentJob() || await readStoredJob();
  if (!stored || stored.jobId !== String(jobId || '')) {
    const error = new Error('Isim tarama sonucu bulunamadi.');
    error.status = 404;
    throw error;
  }

  if (ACTIVE_STATUSES.has(stored.status)) {
    const error = new Error('Tarama tamamlanmadan sonuc kaydedilemez.');
    error.status = 409;
    throw error;
  }

  const ids = new Set(
    (Array.isArray(candidateIds) ? candidateIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  const selected = (stored.results || []).filter((candidate) => ids.has(candidate.id));
  if (selected.length === 0) {
    const error = new Error('Kaydedilecek en az bir yayin secin.');
    error.status = 400;
    throw error;
  }

  const sourceLabel = String(label || '').trim()
    || ('Isim Tarama · ' + stored.query);

  const status = await saveWebScanPlaylistSource({
    label: sourceLabel,
    pageUrl: stored.siteUrl,
    channels: selected.map((candidate, index) => ({
      name: candidate.name || (stored.query + ' ' + (index + 1)),
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
    query: stored.query,
  };
}

export async function deleteSiteNameScanResults(jobId) {
  const stored = currentJob() || await readStoredJob();
  if (!stored || stored.jobId !== String(jobId || '')) {
    const error = new Error('Isim tarama sonucu bulunamadi.');
    error.status = 404;
    throw error;
  }

  if (ACTIVE_STATUSES.has(stored.status)) {
    const error = new Error('Calisan taramanin sonuclari silinemez. Once taramayi durdurun.');
    error.status = 409;
    throw error;
  }

  const deleted = Array.isArray(stored.results) ? stored.results.length : 0;
  try {
    await fs.unlink(jobFile());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  jobs.delete(getTenantId());
  return { cleared: true, deleted };
}
