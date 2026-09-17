import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getTenantDataDir, getTenantId } from './tenantContext.js';
import { saveWebScanPlaylistSource } from './sourceStorage.js';
import {
  assertPublicHttpUrl,
  extractMediaUrlsFromText,
  probeCandidate,
  readTextLimited,
  safeFetch,
} from './webScanService.js';

const SEARCH_RESULT_LIMIT = 24;
const PAGE_INSPECTION_LIMIT = 10;
const MEDIA_CANDIDATE_LIMIT = 18;
const MIN_DURATION_SECONDS = 180;
const PENDING_TTL_MS = 2 * 60 * 60 * 1000;
const activeSearches = new Set();

function pendingFile() {
  return path.join(getTenantDataDir(), 'person-video-scan-pending.json');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagValue(block, tag) {
  const match = String(block || '').match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return decodeXml(match?.[1] || '');
}

function cleanPersonName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.length < 2) {
    const error = new Error('Aranacak kisinin adini yazin.');
    error.status = 400;
    throw error;
  }
  if (name.length > 100) {
    const error = new Error('Kisi adi en fazla 100 karakter olabilir.');
    error.status = 400;
    throw error;
  }
  return name;
}

function hostOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function mediaKind(url) {
  try {
    const match = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
    const extension = match?.[1] || '';
    if (extension === 'm3u8') return 'HLS';
    if (extension === 'mpd') return 'DASH';
    return extension ? extension.toUpperCase() : 'VIDEO';
  } catch {
    return 'VIDEO';
  }
}

function stableId(prefix, value) {
  return prefix + '_' + crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

async function searchVideoPages(personName) {
  const query = '"' + personName + '" (video OR "canli yayin" OR "canlı yayın" OR roportaj OR röportaj)';
  const searchUrl = 'https://www.bing.com/search?format=rss&count='
    + SEARCH_RESULT_LIMIT + '&q=' + encodeURIComponent(query);
  const response = await safeFetch(searchUrl, {
    signal: AbortSignal.timeout(12000),
    headers: { accept: 'application/rss+xml,application/xml,text/xml,*/*' },
  });

  if (!response.ok) throw new Error('Internet aramasi baslatilamadi: HTTP ' + response.status);
  const xml = await readTextLimited(response, 900000);
  const items = [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)];
  const results = [];
  const seen = new Set();

  for (const match of items) {
    const title = tagValue(match[1], 'title');
    const pageUrl = tagValue(match[1], 'link');
    const description = tagValue(match[1], 'description');
    if (!/^https?:\/\//i.test(pageUrl) || seen.has(pageUrl)) continue;

    try {
      await assertPublicHttpUrl(pageUrl);
    } catch {
      continue;
    }

    seen.add(pageUrl);
    results.push({
      id: stableId('page', pageUrl),
      title: title || personName + ' videosu',
      pageUrl,
      sourceHost: hostOf(pageUrl),
      description: description.slice(0, 240),
    });
    if (results.length >= SEARCH_RESULT_LIMIT) break;
  }

  return results;
}

function metaMediaUrls(html, baseUrl) {
  const found = new Set();
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const property = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() || '';
    if (!['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(property)) continue;
    const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    try {
      const absolute = new URL(decodeXml(content), baseUrl).toString();
      if (/^https?:\/\//i.test(absolute)) found.add(absolute);
    } catch {
      // Gecersiz medya adresi yok sayilir.
    }
  }

  return [...found];
}

async function inspectPage(page) {
  try {
    const response = await safeFetch(page.pageUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
    });
    if (!response.ok) return [];
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    if (type && !type.includes('html') && !type.startsWith('text/')) return [];

    const html = await readTextLimited(response, 1400000);
    const urls = new Set([
      ...extractMediaUrlsFromText(html, response.url || page.pageUrl),
      ...metaMediaUrls(html, response.url || page.pageUrl),
    ]);

    return [...urls].slice(0, 8).map((url) => ({
      id: stableId('media', url),
      name: page.title,
      url,
      pageUrl: page.pageUrl,
      sourceHost: page.sourceHost,
      kind: mediaKind(url),
    }));
  } catch {
    return [];
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => run()));
  return output;
}

async function writePending(data) {
  await fs.mkdir(getTenantDataDir(), { recursive: true });
  const target = pendingFile();
  const temp = target + '.tmp';
  await fs.writeFile(temp, JSON.stringify(data, null, 2));
  await fs.rename(temp, target);
}

async function readPending() {
  try {
    const data = JSON.parse(await fs.readFile(pendingFile(), 'utf-8'));
    if (!data?.createdAt || Date.now() - Date.parse(data.createdAt) > PENDING_TTL_MS) return null;
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function scanPersonVideos(rawName) {
  const tenantId = getTenantId();
  if (activeSearches.has(tenantId)) {
    const error = new Error('Bu kullanici icin kisi video aramasi zaten calisiyor.');
    error.status = 409;
    throw error;
  }

  activeSearches.add(tenantId);

  try {
    const personName = cleanPersonName(rawName);
    const pages = await searchVideoPages(personName);
    const inspected = await mapWithConcurrency(
      pages.slice(0, PAGE_INSPECTION_LIMIT),
      4,
      inspectPage
    );

    const candidateMap = new Map();
    for (const candidate of inspected.flat()) {
      if (!candidateMap.has(candidate.url) && candidateMap.size < MEDIA_CANDIDATE_LIMIT) {
        candidateMap.set(candidate.url, candidate);
      }
    }

    const candidates = [...candidateMap.values()];
    const tested = await mapWithConcurrency(candidates, 3, async (candidate) => {
      try {
        const probe = await probeCandidate(candidate.url);
        return {
          ...candidate,
          playable: true,
          live: Boolean(probe.live),
          durationSeconds: Number.isFinite(probe.durationSeconds) ? probe.durationSeconds : null,
          durationStatus: Number.isFinite(probe.durationSeconds) ? 'known' : 'unknown',
        };
      } catch {
        return { ...candidate, playable: false };
      }
    });

    const media = tested
      .filter((item) => item.playable)
      .filter((item) => !Number.isFinite(item.durationSeconds) || item.durationSeconds >= MIN_DURATION_SECONDS);

    const scan = {
      scanId: 'person_' + crypto.randomBytes(12).toString('hex'),
      personName,
      createdAt: new Date().toISOString(),
      pages,
      media,
      summary: {
        searchResults: pages.length,
        pagesInspected: Math.min(pages.length, PAGE_INSPECTION_LIMIT),
        mediaDetected: candidates.length,
        playable: media.length,
        shortRemoved: tested.filter((item) => (
          item.playable
          && Number.isFinite(item.durationSeconds)
          && item.durationSeconds < MIN_DURATION_SECONDS
        )).length,
        failed: tested.filter((item) => !item.playable).length,
      },
      message: pages.length === 0
        ? 'Bu ad icin video veya yayin sonucu bulunamadi.'
        : (
          media.length > 0
            ? media.length + ' dogrudan oynatilabilir yayin bulundu.'
            : 'Video sayfalari bulundu. Dogrudan medya adresi vermeyen sonuclari Kaynagi Ac ile goruntuleyin.'
        ),
    };

    await writePending(scan);
    return scan;
  } finally {
    activeSearches.delete(tenantId);
  }
}

export async function savePersonVideoScanSelection(scanId, candidateIds = [], label = '') {
  const pending = await readPending();
  if (!pending || pending.scanId !== String(scanId || '')) {
    const error = new Error('Kisi video tarama sonucu bulunamadi veya suresi doldu.');
    error.status = 404;
    throw error;
  }

  const ids = new Set(
    (Array.isArray(candidateIds) ? candidateIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const selected = (pending.media || []).filter((candidate) => ids.has(candidate.id));

  if (selected.length === 0) {
    const error = new Error('Kaydedilecek en az bir oynatilabilir yayin secin.');
    error.status = 400;
    throw error;
  }

  const sourceLabel = String(label || '').trim() || ('Kisi Videolari · ' + pending.personName);
  const status = await saveWebScanPlaylistSource({
    label: sourceLabel,
    pageUrl: selected[0]?.pageUrl || '',
    channels: selected.map((candidate, index) => ({
      name: candidate.name || (pending.personName + ' · Video ' + (index + 1)),
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

export async function deletePersonVideoScanResults(scanId) {
  const pending = await readPending();
  if (!pending || pending.scanId !== String(scanId || '')) {
    const error = new Error('Kisi video tarama sonucu bulunamadi veya suresi doldu.');
    error.status = 404;
    throw error;
  }

  const deleted = (pending.pages?.length || 0) + (pending.media?.length || 0);
  try {
    await fs.unlink(pendingFile());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { scanId: pending.scanId, deleted };
}
