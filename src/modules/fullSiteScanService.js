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

const PAGE_LIMITS = new Set([50, 100, 200]);
const MIN_DURATION_SECONDS = 180;
const MAX_QUEUE_SIZE = 2500;
const MAX_MEDIA_CANDIDATES = 300;
const MAX_RESULTS = 200;
const PAGE_FETCH_TIMEOUT_MS = 12000;
const BROWSER_PAGE_TIMEOUT_MS = 11000;
const BROWSER_SETTLE_MS = 1800;
const PROBE_TIMEOUT_MS = 12000;
const MAX_BODY_BYTES = 1800000;
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 Siberdeyz-Full-Site-Scanner/1.0';
const MEDIA_EXTENSIONS = new Set(['m3u8', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mpd']);
const TERMINAL_STATUSES = new Set(['completed', 'stopped', 'failed']);
const ACTIVE_STATUSES = new Set(['running', 'paused', 'stopping']);
const jobs = new Map();

function jobFileForCurrentTenant() {
  return path.join(getTenantDataDir(), 'full-site-scan-job.json');
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
  const input = String(value || '').trim();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : ('https://' + input.replace(/^\/+/, ''));

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

function siteRootHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^(?:www|m)\./, '');
}

function isSameSite(rootHost, candidateHost) {
  const root = siteRootHost(rootHost);
  const candidate = siteRootHost(candidateHost);
  return candidate === root || candidate.endsWith('.' + root);
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

function safeMediaName(value, fallbackIndex) {
  try {
    const parsed = new URL(value);
    const raw = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
    const cleaned = raw
      .replace(/\.(m3u8|mp4|m4v|mov|webm|mkv|mpd)$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim();

    return cleaned && cleaned.toLowerCase() !== 'index'
      ? cleaned.slice(0, 100)
      : ('Site Yayini ' + fallbackIndex);
  } catch {
    return 'Site Yayini ' + fallbackIndex;
  }
}

function mediaId(url) {
  return 'full_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function mediaKind(url) {
  const extension = extensionOf(url);
  if (extension === 'm3u8') return 'HLS';
  if (extension === 'mpd') return 'DASH';
  return extension ? extension.toUpperCase() : 'VIDEO';
}

function cleanTitle(value, fallback = '') {
  const title = String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!title || /^(please wait|just a moment|loading)$/i.test(title)) return fallback;
  return title.slice(0, 120);
}

function decodeHref(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/gi, '&')
    .trim();
}

function shouldSkipPageUrl(value) {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(?:jpg|jpeg|png|gif|webp|svg|ico|css|js|json|xml|txt|zip|rar|7z|pdf|docx?|xlsx?|woff2?|ttf|eot)(?:$|\/)/i.test(pathname)) return true;

    const combined = (pathname + ' ' + parsed.search).toLowerCase();
    return /(?:logout|signout|login|register|signup|privacy|terms|contact|about|mailto:|javascript:)/i.test(combined);
  } catch {
    return true;
  }
}

function scorePageLink(url, text = '') {
  try {
    const parsed = new URL(url);
    const combined = [parsed.pathname, parsed.search, text].join(' ').toLowerCase();
    let score = 1;

    if (/video|watch|izle|film|movie|episode|embed|player|view|tube|clip|media/i.test(combined)) score += 8;
    if (/\/\d{2,}(?:\/|$)/.test(parsed.pathname)) score += 2;
    score += Math.min(parsed.pathname.split('/').filter(Boolean).length, 4);
    if (String(text || '').trim().length > 10) score += 1;

    return score;
  } catch {
    return 0;
  }
}

function extractLinksFromHtml(html, baseUrl, rootHost) {
  const found = new Map();
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || '').matchAll(pattern)) {
    if (found.size >= MAX_QUEUE_SIZE) break;

    try {
      const href = decodeHref(match[1]);
      if (!href || /^(?:mailto:|tel:|javascript:|data:)/i.test(href)) continue;

      const absolute = normalizePageUrl(new URL(href, baseUrl).toString());
      if (!absolute || shouldSkipPageUrl(absolute)) continue;

      const parsed = new URL(absolute);
      if (!isSameSite(rootHost, parsed.hostname)) continue;

      const text = cleanTitle(match[2], '');
      const score = scorePageLink(absolute, text);
      const current = found.get(absolute);

      if (!current || score > current.score) {
        found.set(absolute, { url: absolute, text, score });
      }
    } catch {
      // Gecersiz link yok sayilir.
    }
  }

  return [...found.values()];
}

function extractMediaUrlsFromText(text, baseUrl) {
  const found = new Set();
  const normalized = String(text || '').replace(/\\\//g, '/');

  const absolutePattern = /https?:\/\/[^"'<>\s]+?\.(?:m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:\?[^"'<>\s]*)?/gi;
  for (const match of normalized.matchAll(absolutePattern)) {
    try {
      found.add(new URL(match[0], baseUrl).toString());
    } catch {
      // Gecersiz medya URL yok sayilir.
    }
  }

  const relativePattern = /(?:src|href|file|url)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|m4v|mov|webm|mkv|mpd)(?:\?[^"']*)?)["']/gi;
  for (const match of normalized.matchAll(relativePattern)) {
    try {
      found.add(new URL(match[1], baseUrl).toString());
    } catch {
      // Gecersiz medya URL yok sayilir.
    }
  }

  return [...found];
}

function pageHasPlayerSignal(html, url) {
  const sample = (String(html || '').slice(0, 600000) + ' ' + String(url || '')).toLowerCase();
  return /<video|<source|<iframe|jwplayer|videojs|video-js|plyr|hls\.js|dash\.js|player|watch|embed/.test(sample);
}

function isProtectionPage(title, bodyText, linkCount, mediaCount) {
  const combined = (String(title || '') + ' ' + String(bodyText || '')).toLowerCase();

  return (
    /checking your browser|verify you are human|cloudflare ray id|cf-chl-|attention required/.test(combined)
    || (
      /please wait|just a moment/.test(String(title || '').toLowerCase())
      && Number(linkCount) < 3
      && Number(mediaCount) === 0
    )
  );
}

function addMediaCandidate(job, rawUrl, meta = {}) {
  if (job.mediaCandidates.size >= MAX_MEDIA_CANDIDATES) return;

  try {
    const url = new URL(String(rawUrl || ''), meta.sourcePage || job.rootUrl).toString();
    if (!/^https?:\/\//i.test(url)) return;
    if (!looksLikeMediaUrl(url) && !meta.allowUnknownExtension) return;
    if (job.mediaCandidates.has(url)) return;

    const index = job.mediaCandidates.size + 1;
    job.mediaCandidates.set(url, {
      id: mediaId(url),
      url,
      name: cleanTitle(meta.name, safeMediaName(url, index)),
      kind: mediaKind(url),
      discoveredBy: String(meta.discoveredBy || 'site'),
      sourcePage: String(meta.sourcePage || '').slice(0, 500),
    });
  } catch {
    // Gecersiz medya adayi yok sayilir.
  }
}

function enqueuePage(job, entry) {
  if (job.queue.length >= MAX_QUEUE_SIZE) return;

  const url = normalizePageUrl(entry?.url);
  if (!url || job.visited.has(url) || job.queued.has(url) || shouldSkipPageUrl(url)) return;

  try {
    const parsed = new URL(url);
    if (!isSameSite(job.rootHost, parsed.hostname)) return;
  } catch {
    return;
  }

  job.queue.push({
    url,
    score: Number(entry?.score) || 1,
    text: String(entry?.text || '').slice(0, 120),
  });
  job.queued.add(url);

  if (job.queue.length > 1) {
    job.queue.sort((left, right) => right.score - left.score);
  }
}

function snapshotJob(job) {
  if (!job) return null;

  return {
    jobId: job.id,
    rootUrl: job.rootUrl,
    pageLimit: job.pageLimit,
    status: job.status,
    phase: job.phase,
    message: job.message,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt || '',
    progress: {
      pagesVisited: job.visited.size,
      pagesQueued: job.queue.length,
      dynamicPages: job.dynamicPages,
      pageErrors: job.pageErrors,
      protectionPages: job.protectionPages,
      mediaFound: job.mediaCandidates.size,
      mediaTested: job.mediaTested,
      accepted: job.results.length,
      shortRemoved: job.shortRemoved,
      mediaFailed: job.mediaFailed,
    },
    results: job.results.slice(0, MAX_RESULTS),
  };
}

async function persistJob(job, force = false) {
  const now = Date.now();
  if (!force && now - job.lastPersistAt < 1500) return;
  job.lastPersistAt = now;

  try {
    await fs.mkdir(path.dirname(job.stateFile), { recursive: true });
    const temp = job.stateFile + '.tmp';
    await fs.writeFile(temp, JSON.stringify(snapshotJob(job), null, 2));
    await fs.rename(temp, job.stateFile);
  } catch {
    // Persist hatasi taramayi durdurmamali.
  }
}

async function readPersistedJob(stateFile) {
  try {
    const data = JSON.parse(await fs.readFile(stateFile, 'utf-8'));
    if (ACTIVE_STATUSES.has(data?.status)) {
      return {
        ...data,
        status: 'stopped',
        phase: 'stopped',
        message: 'Tarama sunucu yeniden basladigi icin durdu. Yeni tarama baslatabilirsiniz.',
        finishedAt: data.finishedAt || new Date().toISOString(),
      };
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function waitIfPaused(job) {
  while (job.pauseRequested && !job.stopRequested) {
    job.status = 'paused';
    job.message = 'Tarama duraklatildi.';
    job.updatedAt = new Date().toISOString();
    await persistJob(job);
    await delay(450);
  }

  if (!job.stopRequested && job.status === 'paused') {
    job.status = 'running';
    job.message = job.phase === 'testing'
      ? 'Bulunan yayinlar test ediliyor...'
      : 'Site sayfalari taraniyor...';
    job.updatedAt = new Date().toISOString();
  }
}

async function fetchPageStatic(job, url) {
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    headers: {
      accept: 'text/html,application/xhtml+xml,text/plain,*/*',
    },
  });

  if (!response.ok) throw new Error('HTTP ' + response.status);

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('html') && !contentType.startsWith('text/')) {
    if (isMediaContentType(contentType)) {
      addMediaCandidate(job, response.url || url, {
        discoveredBy: 'page-response',
        sourcePage: url,
        allowUnknownExtension: true,
      });
    }
    return { title: '', html: '', links: [], playerSignal: false };
  }

  const html = await readTextLimited(response);
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = cleanTitle(titleMatch?.[1], '');

  for (const mediaUrl of extractMediaUrlsFromText(html, response.url || url)) {
    addMediaCandidate(job, mediaUrl, {
      discoveredBy: 'html',
      name: title,
      sourcePage: url,
    });
  }

  return {
    title,
    html,
    links: extractLinksFromHtml(html, response.url || url, job.rootHost),
    playerSignal: pageHasPlayerSignal(html, url),
  };
}

async function scanPageDynamically(job, browser, targetUrl, fallbackTitle = '') {
  const page = await browser.newPage();
  const responseTasks = [];
  let title = fallbackTitle;
  let bodyScans = 0;
  const dynamicLinks = [];

  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(USER_AGENT);
    await page.setBypassCSP(true);
    await page.setRequestInterception(true);

    page.on('dialog', (dialog) => {
      dialog.dismiss().catch(() => {});
    });

    page.on('request', async (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();

      if (requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
        request.continue().catch(() => {});
        return;
      }

      if (!/^https?:\/\//i.test(requestUrl)) {
        request.abort().catch(() => {});
        return;
      }

      if (looksLikeMediaUrl(requestUrl)) {
        addMediaCandidate(job, requestUrl, {
          discoveredBy: 'request',
          name: title,
          sourcePage: targetUrl,
        });
      }

      if (resourceType === 'image' || resourceType === 'font') {
        request.abort().catch(() => {});
        return;
      }

      try {
        await assertPublicHttpUrl(requestUrl);
        request.continue().catch(() => {});
      } catch {
        request.abort().catch(() => {});
      }
    });

    page.on('response', (response) => {
      const contentType = String(response.headers()['content-type'] || '').toLowerCase();
      const responseUrl = response.url();
      const resourceType = response.request().resourceType();

      if (looksLikeMediaUrl(responseUrl) || isMediaContentType(contentType)) {
        addMediaCandidate(job, responseUrl, {
          discoveredBy: 'response',
          name: title,
          sourcePage: targetUrl,
          allowUnknownExtension: isMediaContentType(contentType),
        });
      }

      if (
        bodyScans < 8
        && ['xhr', 'fetch', 'script'].includes(resourceType)
        && (
          contentType.includes('json')
          || contentType.includes('javascript')
          || contentType.startsWith('text/')
        )
      ) {
        bodyScans += 1;
        responseTasks.push(
          response.text()
            .then((body) => {
              if (!body || body.length > 1500000) return;
              for (const mediaUrl of extractMediaUrlsFromText(body, responseUrl)) {
                addMediaCandidate(job, mediaUrl, {
                  discoveredBy: 'xhr-body',
                  name: title,
                  sourcePage: targetUrl,
                });
              }
            })
            .catch(() => {})
        );
      }
    });

    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: BROWSER_PAGE_TIMEOUT_MS,
    });

    title = cleanTitle(await page.title().catch(() => ''), fallbackTitle);

    const firstSignals = await page.evaluate(() => {
      const mediaUrls = new Set();
      document.querySelectorAll('video,audio,source').forEach((element) => {
        [
          element.currentSrc,
          element.src,
          element.getAttribute?.('src'),
          element.getAttribute?.('data-src'),
          element.getAttribute?.('data-file'),
        ].filter(Boolean).forEach((value) => mediaUrls.add(String(value)));
      });

      const links = [...document.querySelectorAll('a[href]')].slice(0, 500).map((anchor) => ({
        href: String(anchor.href || ''),
        text: String(anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      }));

      document.querySelectorAll('video,audio').forEach((media) => {
        try {
          media.muted = true;
          media.preload = 'auto';
          media.play().catch(() => {});
        } catch {
          // Oynatici desteklemiyorsa devam edilir.
        }
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

      let clicks = 0;
      for (const selector of playSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (clicks >= 3) break;
          if (!(element instanceof HTMLElement)) continue;
          try {
            element.click();
            clicks += 1;
          } catch {
            // Tıklanamazsa devam edilir.
          }
        }
        if (clicks >= 3) break;
      }

      window.scrollTo(0, Math.min(document.body?.scrollHeight || 0, 4200));

      return {
        bodyText: String(document.body?.innerText || '').slice(0, 1800),
        mediaUrls: [...mediaUrls],
        links,
      };
    }).catch(() => ({ bodyText: '', mediaUrls: [], links: [] }));

    for (const mediaUrl of firstSignals.mediaUrls) {
      addMediaCandidate(job, mediaUrl, {
        discoveredBy: 'dom',
        name: title,
        sourcePage: targetUrl,
      });
    }

    for (const link of firstSignals.links) {
      try {
        const absolute = normalizePageUrl(new URL(link.href, targetUrl).toString());
        if (!absolute) continue;
        const parsed = new URL(absolute);
        if (!isSameSite(job.rootHost, parsed.hostname)) continue;
        dynamicLinks.push({
          url: absolute,
          text: link.text,
          score: scorePageLink(absolute, link.text),
        });
      } catch {
        // Gecersiz link yok sayilir.
      }
    }

    if (isProtectionPage(title, firstSignals.bodyText, firstSignals.links.length, firstSignals.mediaUrls.length)) {
      job.protectionPages += 1;
    }

    await delay(BROWSER_SETTLE_MS);

    const lateUrls = await page.evaluate(() => {
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

    for (const value of lateUrls) {
      if (looksLikeMediaUrl(value)) {
        addMediaCandidate(job, value, {
          discoveredBy: 'performance',
          name: title,
          sourcePage: targetUrl,
        });
      }
    }

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;

      const frameMedia = await frame.evaluate(() => (
        [...document.querySelectorAll('video,audio,source')]
          .flatMap((element) => [element.currentSrc, element.src, element.getAttribute?.('src')])
          .filter(Boolean)
          .map(String)
      )).catch(() => []);

      for (const value of frameMedia) {
        addMediaCandidate(job, value, {
          discoveredBy: 'iframe',
          name: title,
          sourcePage: targetUrl,
        });
      }
    }

    await Promise.allSettled(responseTasks);
    return dynamicLinks;
  } finally {
    await page.close().catch(() => {});
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
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-rw_timeout', String(PROBE_TIMEOUT_MS * 1000),
      '-user_agent', USER_AGENT,
      '-show_entries', 'format=duration,format_name',
      '-of', 'json',
      url,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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

async function probeMedia(url) {
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

async function testMediaCandidates(job) {
  job.phase = 'testing';
  job.status = 'running';
  job.message = 'Bulunan yayinlar test ediliyor ve 3 dakika filtresinden geciriliyor...';
  job.updatedAt = new Date().toISOString();
  await persistJob(job, true);

  const candidates = [...job.mediaCandidates.values()];
  let cursor = 0;

  async function worker() {
    while (cursor < candidates.length) {
      if (job.stopRequested) return;
      await waitIfPaused(job);
      if (job.stopRequested) return;

      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];

      try {
        const probe = await probeMedia(candidate.url);
        job.mediaTested += 1;

        if (Number.isFinite(probe.durationSeconds) && probe.durationSeconds < MIN_DURATION_SECONDS) {
          job.shortRemoved += 1;
        } else if (job.results.length < MAX_RESULTS) {
          job.results.push({
            ...candidate,
            playable: true,
            live: Boolean(probe.live),
            durationSeconds: Number.isFinite(probe.durationSeconds) ? probe.durationSeconds : null,
            durationStatus: Number.isFinite(probe.durationSeconds) ? 'known' : 'unknown',
          });
        }
      } catch {
        job.mediaTested += 1;
        job.mediaFailed += 1;
      }

      job.updatedAt = new Date().toISOString();
      await persistJob(job);
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, candidates.length || 1) }, () => worker()));
}

async function runJob(job) {
  let browser = null;

  try {
    job.status = 'running';
    job.phase = 'crawling';
    job.message = 'Site sayfalari taraniyor...';
    job.updatedAt = new Date().toISOString();

    browser = await puppeteer.launch({
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

    enqueuePage(job, { url: job.rootUrl, score: 100, text: 'Ana sayfa' });
    const dynamicBudget = Math.min(40, Math.max(12, Math.ceil(job.pageLimit * 0.35)));

    while (job.queue.length > 0 && job.visited.size < job.pageLimit) {
      if (job.stopRequested) break;
      await waitIfPaused(job);
      if (job.stopRequested) break;

      const entry = job.queue.shift();
      job.queued.delete(entry.url);
      if (job.visited.has(entry.url)) continue;

      job.visited.add(entry.url);
      job.updatedAt = new Date().toISOString();
      job.message = 'Sayfa taraniyor: ' + job.visited.size + '/' + job.pageLimit;

      let staticResult = {
        title: '',
        html: '',
        links: [],
        playerSignal: false,
      };

      try {
        staticResult = await fetchPageStatic(job, entry.url);
        for (const link of staticResult.links) enqueuePage(job, link);
      } catch {
        job.pageErrors += 1;
      }

      const shouldUseBrowser = (
        job.dynamicPages < dynamicBudget
        && (
          job.visited.size === 1
          || staticResult.playerSignal
          || entry.score >= 8
        )
      );

      if (shouldUseBrowser && !job.stopRequested) {
        try {
          const dynamicLinks = await scanPageDynamically(job, browser, entry.url, staticResult.title);
          job.dynamicPages += 1;
          for (const link of dynamicLinks) enqueuePage(job, link);
        } catch {
          job.pageErrors += 1;
        }
      }

      await persistJob(job);
    }

    if (job.stopRequested) {
      job.status = 'stopped';
      job.phase = 'stopped';
      job.message = 'Taramayi siz durdurdunuz.';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await persistJob(job, true);
      return;
    }

    if (job.mediaCandidates.size === 0) {
      job.status = 'completed';
      job.phase = 'completed';
      job.message = job.protectionPages > 0
        ? 'Tarama tamamlandi ancak koruma sayfalari nedeniyle erisilebilir yayin bulunamadi.'
        : 'Tarama tamamlandi; erisilebilir medya istegi bulunamadi.';
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      await persistJob(job, true);
      return;
    }

    await browser.close().catch(() => {});
    browser = null;

    await testMediaCandidates(job);

    if (job.stopRequested) {
      job.status = 'stopped';
      job.phase = 'stopped';
      job.message = 'Yayin testi durduruldu. Test edilen sonuclar korunuyor.';
    } else {
      job.status = 'completed';
      job.phase = 'completed';
      job.message = job.results.length > 0
        ? job.results.length + ' kaydedilebilir yayin bulundu.'
        : 'Medya adaylari bulundu ancak 3 dakika ve oynatma testlerinden gecen yayin kalmadi.';
    }

    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await persistJob(job, true);

    console.info('Full site scan completed:', JSON.stringify({
      pagesVisited: job.visited.size,
      pageLimit: job.pageLimit,
      dynamicPages: job.dynamicPages,
      mediaFound: job.mediaCandidates.size,
      mediaTested: job.mediaTested,
      accepted: job.results.length,
      shortRemoved: job.shortRemoved,
      mediaFailed: job.mediaFailed,
      protectionPages: job.protectionPages,
      status: job.status,
    }));
  } catch (error) {
    job.status = 'failed';
    job.phase = 'failed';
    job.message = String(error?.message || 'Tum site taramasi tamamlanamadi.').slice(0, 240);
    job.finishedAt = new Date().toISOString();
    job.updatedAt = job.finishedAt;
    await persistJob(job, true);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function activeJobForTenant(tenantId) {
  return jobs.get(tenantId) || null;
}

export async function startFullSiteScan(rawUrl, rawLimit = 50) {
  const tenantId = getTenantId();
  const existing = activeJobForTenant(tenantId);

  if (existing && ACTIVE_STATUSES.has(existing.status)) {
    const error = new Error('Bu kullanici icin zaten bir Tum Site taramasi calisiyor.');
    error.status = 409;
    throw error;
  }

  const parsed = await assertPublicHttpUrl(rawUrl);
  const pageLimit = PAGE_LIMITS.has(Number(rawLimit)) ? Number(rawLimit) : 50;
  const now = new Date().toISOString();

  const job = {
    id: 'fullscan_' + crypto.randomBytes(12).toString('hex'),
    tenantId,
    stateFile: jobFileForCurrentTenant(),
    rootUrl: parsed.toString(),
    rootHost: parsed.hostname,
    pageLimit,
    status: 'running',
    phase: 'crawling',
    message: 'Tum Site taramasi baslatiliyor...',
    startedAt: now,
    updatedAt: now,
    finishedAt: '',
    queue: [],
    queued: new Set(),
    visited: new Set(),
    mediaCandidates: new Map(),
    results: [],
    dynamicPages: 0,
    pageErrors: 0,
    protectionPages: 0,
    mediaTested: 0,
    shortRemoved: 0,
    mediaFailed: 0,
    pauseRequested: false,
    stopRequested: false,
    lastPersistAt: 0,
  };

  jobs.set(tenantId, job);
  await persistJob(job, true);
  void runJob(job);

  return snapshotJob(job);
}

export async function getFullSiteScanStatus() {
  const tenantId = getTenantId();
  const job = activeJobForTenant(tenantId);
  if (job) return snapshotJob(job);

  return readPersistedJob(jobFileForCurrentTenant());
}

export async function pauseFullSiteScan() {
  const job = activeJobForTenant(getTenantId());

  if (!job || TERMINAL_STATUSES.has(job.status)) {
    const error = new Error('Duraklatilacak aktif Tum Site taramasi yok.');
    error.status = 404;
    throw error;
  }

  job.pauseRequested = true;
  job.status = 'paused';
  job.message = 'Tarama duraklatiliyor...';
  job.updatedAt = new Date().toISOString();
  await persistJob(job, true);
  return snapshotJob(job);
}

export async function resumeFullSiteScan() {
  const job = activeJobForTenant(getTenantId());

  if (!job || job.status !== 'paused') {
    const error = new Error('Devam ettirilecek duraklatilmis tarama yok.');
    error.status = 404;
    throw error;
  }

  job.pauseRequested = false;
  job.status = 'running';
  job.message = job.phase === 'testing'
    ? 'Yayin testine devam ediliyor...'
    : 'Site taramasina devam ediliyor...';
  job.updatedAt = new Date().toISOString();
  await persistJob(job, true);
  return snapshotJob(job);
}

export async function stopFullSiteScan() {
  const job = activeJobForTenant(getTenantId());

  if (!job || TERMINAL_STATUSES.has(job.status)) {
    const error = new Error('Durdurulacak aktif Tum Site taramasi yok.');
    error.status = 404;
    throw error;
  }

  job.stopRequested = true;
  job.pauseRequested = false;
  job.status = 'stopping';
  job.message = 'Tarama durduruluyor...';
  job.updatedAt = new Date().toISOString();
  await persistJob(job, true);
  return snapshotJob(job);
}

export async function saveFullSiteScanSelection(jobId, candidateIds = [], label = '') {
  const tenantId = getTenantId();
  const active = activeJobForTenant(tenantId);
  const snapshot = active
    ? snapshotJob(active)
    : await readPersistedJob(jobFileForCurrentTenant());

  if (!snapshot || snapshot.jobId !== String(jobId || '')) {
    const error = new Error('Tum Site tarama sonucu bulunamadi.');
    error.status = 404;
    throw error;
  }

  const ids = new Set(
    (Array.isArray(candidateIds) ? candidateIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  const selected = (snapshot.results || []).filter((candidate) => ids.has(candidate.id));

  if (selected.length === 0) {
    const error = new Error('Kaydedilecek en az bir yayin secin.');
    error.status = 400;
    throw error;
  }

  const sourceLabel = String(label || '').trim()
    || ('Tum Site · ' + new URL(snapshot.rootUrl).hostname);

  const status = await saveWebScanPlaylistSource({
    label: sourceLabel,
    pageUrl: snapshot.rootUrl,
    channels: selected.map((candidate, index) => ({
      name: candidate.name || ('Site Yayini ' + (index + 1)),
      group: 'Web Tarama',
      url: candidate.url,
      webDurationSeconds: Number.isFinite(candidate.durationSeconds)
        ? candidate.durationSeconds
        : null,
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
