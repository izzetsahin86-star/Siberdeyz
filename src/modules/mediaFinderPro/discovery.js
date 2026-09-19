import {
  extractIframeUrls,
  extractMediaCandidatesFromText,
  extractPageLinks,
  isMediaContentType,
  looksLikeMediaUrl,
  pageTitleFromHtml,
  queryScore,
  stripHtml,
} from './extractors.js';
import { discoverBrowserSearch, discoverMediaWithBrowser } from './browserDiscovery.js';
import {
  canonicalPageUrl,
  isSameSite,
  readTextLimited,
  safeFetch,
} from './urlSafety.js';

const FETCH_TIMEOUT_MS = 12_000;
const MAX_MATCH_PAGES = 18;
const MAX_MEDIA_CANDIDATES = 140;
const MAX_SITEMAPS = 8;

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function xmlLocations(xml) {
  return [...String(xml || '').matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)]
    .map((match) => decodeXml(match[1]).trim())
    .filter(Boolean);
}

function addPage(store, rawUrl, rootHostname, query, meta = {}) {
  try {
    const url = canonicalPageUrl(new URL(String(rawUrl || ''), meta.baseUrl || undefined).toString());
    if (!url) return;
    const parsed = new URL(url);
    if (!isSameSite(rootHostname, parsed.hostname)) return;

    const title = String(meta.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const context = String(meta.context || '').slice(0, 4_000);
    const score = Math.max(Number(meta.score || 0), queryScore(title + ' ' + context + ' ' + url, query));
    if (score < 6) return;

    const current = store.get(url);
    if (!current || score > current.score) {
      store.set(url, {
        url,
        title: title || parsed.pathname || parsed.hostname,
        score,
        source: String(meta.source || 'search'),
      });
    }
  } catch {
    // Invalid search page is ignored.
  }
}

function collectJsonPages(value, baseUrl, rootHostname, query, store, depth = 0) {
  if (depth > 7 || value == null || store.size >= 80) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 300)) {
      collectJsonPages(item, baseUrl, rootHostname, query, store, depth + 1);
    }
    return;
  }

  if (typeof value !== 'object') return;

  const title = [
    value.title?.rendered,
    value.title,
    value.name,
    value.label,
    value.caption,
  ].filter((entry) => typeof entry === 'string').join(' ');

  const context = [
    value.excerpt?.rendered,
    value.excerpt,
    value.description,
    value.content?.rendered,
  ].filter((entry) => typeof entry === 'string').join(' ').slice(0, 4_000);

  for (const candidate of [value.url, value.link, value.href, value.permalink, value.path]) {
    if (typeof candidate !== 'string') continue;
    addPage(store, candidate, rootHostname, query, {
      baseUrl,
      title,
      context,
      source: 'json-search',
    });
  }

  for (const child of Object.values(value).slice(0, 100)) {
    collectJsonPages(child, baseUrl, rootHostname, query, store, depth + 1);
  }
}

function commonSearchEndpoints(siteUrl, query) {
  const origin = new URL(siteUrl).origin;
  const encoded = encodeURIComponent(query);
  return [
    '/?s=' + encoded,
    '/search?q=' + encoded,
    '/search?query=' + encoded,
    '/search?search=' + encoded,
    '/search/' + encoded + '/',
    '/arama?q=' + encoded,
    '/arama?search=' + encoded,
    '/index.php?do=search&subaction=search&story=' + encoded,
    '/index.php?do=search&story=' + encoded,
    '/wp-json/wp/v2/search?search=' + encoded + '&per_page=50',
    '/wp-json/wp/v2/posts?search=' + encoded + '&per_page=50&_fields=link,title,excerpt',
    '/wp-json/wp/v2/pages?search=' + encoded + '&per_page=50&_fields=link,title,excerpt',
    '/api/search?q=' + encoded,
    '/api/v1/search?q=' + encoded,
  ].map((pathname) => new URL(pathname, origin).toString());
}

async function discoverSearchEndpoints(siteUrl, query) {
  const root = new URL(siteUrl);
  const found = new Map();
  let checked = 0;

  const endpoints = commonSearchEndpoints(siteUrl, query);
  let cursor = 0;

  async function worker() {
    while (cursor < endpoints.length && found.size < 60) {
      const endpoint = endpoints[cursor];
      cursor += 1;

      try {
        const response = await safeFetch(endpoint, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { accept: 'text/html,application/json,text/plain,*/*' },
        });
        checked += 1;
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          continue;
        }

        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const body = await readTextLimited(response, 1_400_000);
        const finalUrl = response.url || endpoint;

        if (contentType.includes('json') || /^\s*[\[{]/.test(body)) {
          try {
            collectJsonPages(JSON.parse(body), finalUrl, root.hostname, query, found);
          } catch {
            // Some endpoints label HTML as JSON; HTML parsing below handles it.
          }
        }

        for (const page of extractPageLinks(body, finalUrl, root.hostname, query).slice(0, 80)) {
          addPage(found, page.url, root.hostname, query, {
            ...page,
            source: 'search-endpoint',
          });
        }

        const title = pageTitleFromHtml(body);
        const score = queryScore(title + ' ' + stripHtml(body).slice(0, 180_000) + ' ' + finalUrl, query);
        if (score >= 18) {
          addPage(found, finalUrl, root.hostname, query, {
            title,
            score,
            source: 'search-result-page',
          });
        }
      } catch {
        checked += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: 4 }, () => worker()));
  return { checked, pages: [...found.values()] };
}

async function discoverSitemaps(siteUrl, query) {
  const root = new URL(siteUrl);
  const queue = [];
  const visited = new Set();
  const found = new Map();

  try {
    const robotsUrl = new URL('/robots.txt', root.origin).toString();
    const response = await safeFetch(robotsUrl, {
      signal: AbortSignal.timeout(7_000),
      headers: { accept: 'text/plain,*/*' },
    });
    if (response.ok) {
      const body = await readTextLimited(response, 300_000);
      for (const match of body.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        queue.push(new URL(match[1].trim(), response.url || robotsUrl).toString());
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
  } catch {
    // robots.txt is optional.
  }

  for (const pathname of ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/wp-sitemap.xml']) {
    queue.push(new URL(pathname, root.origin).toString());
  }

  while (queue.length && visited.size < MAX_SITEMAPS && found.size < 60) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    try {
      const response = await safeFetch(sitemapUrl, {
        signal: AbortSignal.timeout(9_000),
        headers: { accept: 'application/xml,text/xml,text/plain,*/*' },
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        continue;
      }

      const xml = await readTextLimited(response, 3_000_000);
      if (!/<(?:urlset|sitemapindex|url|sitemap)\b/i.test(xml)) continue;

      if (/<sitemapindex\b/i.test(xml)) {
        for (const child of xmlLocations(xml).slice(0, 80)) {
          try {
            const parsed = new URL(child, response.url || sitemapUrl);
            if (isSameSite(root.hostname, parsed.hostname) && !visited.has(parsed.toString())) {
              queue.push(parsed.toString());
            }
          } catch {
            // Ignore invalid child sitemaps.
          }
        }
      }

      for (const blockMatch of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
        const block = blockMatch[1];
        const location = xmlLocations(block)[0];
        if (!location) continue;
        const score = queryScore(block + ' ' + location, query);
        if (score < 6) continue;

        addPage(found, location, root.hostname, query, {
          baseUrl: response.url || sitemapUrl,
          title: stripHtml(block).slice(0, 180),
          context: block,
          score,
          source: 'sitemap',
        });
        if (found.size >= 60) break;
      }
    } catch {
      // Continue with the next sitemap.
    }
  }

  return { checked: visited.size, pages: [...found.values()] };
}

async function fetchHtmlPage(url) {
  const response = await safeFetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error('HTTP ' + response.status);
  }

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (isMediaContentType(contentType) || looksLikeMediaUrl(response.url || url)) {
    await response.body?.cancel().catch(() => {});
    return { url: response.url || url, contentType, html: '', mediaResponse: true };
  }

  if (contentType && !contentType.includes('html') && !contentType.startsWith('text/')) {
    await response.body?.cancel().catch(() => {});
    throw new Error('HTML olmayan icerik');
  }

  return {
    url: response.url || url,
    contentType,
    html: await readTextLimited(response, 2_500_000),
    mediaResponse: false,
  };
}

export async function discoverMatchingPages(siteUrl, query, pageLimit, { onProgress, shouldContinue } = {}) {
  const root = new URL(siteUrl);
  const seedMap = new Map();
  const strategy = { endpoints: 0, sitemaps: 0, browser: false };

  const [endpointResult, sitemapResult, browserResult] = await Promise.allSettled([
    discoverSearchEndpoints(siteUrl, query),
    discoverSitemaps(siteUrl, query),
    discoverBrowserSearch(siteUrl, query),
  ]);

  if (endpointResult.status === 'fulfilled') {
    strategy.endpoints = endpointResult.value.checked;
    for (const page of endpointResult.value.pages) addPage(seedMap, page.url, root.hostname, query, page);
  }
  if (sitemapResult.status === 'fulfilled') {
    strategy.sitemaps = sitemapResult.value.checked;
    for (const page of sitemapResult.value.pages) addPage(seedMap, page.url, root.hostname, query, page);
  }
  if (browserResult.status === 'fulfilled') {
    strategy.browser = browserResult.value.method === 'browser-search';
    for (const page of browserResult.value.pages) addPage(seedMap, page.url, root.hostname, query, page);
  }

  const prioritized = [...seedMap.values()].sort((left, right) => right.score - left.score);
  const queue = [...prioritized.map((page) => page.url), canonicalPageUrl(siteUrl)].filter(Boolean);
  const queued = new Set(queue);
  const visited = new Set();
  const matches = new Map();
  let errors = 0;

  for (const seed of prioritized) {
    if (seed.score < 28 || matches.size >= MAX_MATCH_PAGES) continue;
    matches.set(seed.url, {
      url: seed.url,
      title: seed.title,
      score: seed.score,
      source: seed.source,
    });
  }

  const limit = Math.max(10, Math.min(120, Number(pageLimit) || 40));
  while (queue.length && visited.size < limit && matches.size < MAX_MATCH_PAGES) {
    if (typeof shouldContinue === 'function' && !(await shouldContinue())) break;

    const batch = [];
    while (queue.length && batch.length < 4 && visited.size + batch.length < limit) {
      const url = queue.shift();
      queued.delete(url);
      if (!url || visited.has(url)) continue;
      batch.push(url);
    }
    if (!batch.length) continue;
    batch.forEach((url) => visited.add(url));

    const fetched = await Promise.all(batch.map(async (url) => {
      try {
        return { requestedUrl: url, page: await fetchHtmlPage(url) };
      } catch {
        errors += 1;
        return null;
      }
    }));

    for (const item of fetched.filter(Boolean)) {
      const { page } = item;
      if (page.mediaResponse || !page.html) continue;

      const finalUrl = canonicalPageUrl(page.url) || item.requestedUrl;
      const title = pageTitleFromHtml(page.html);
      const visible = stripHtml(page.html).slice(0, 350_000);
      const score = queryScore(title + ' ' + visible + ' ' + finalUrl, query);

      if (score >= 18 && matches.size < MAX_MATCH_PAGES) {
        matches.set(finalUrl, {
          url: finalUrl,
          title: title || new URL(finalUrl).pathname || root.hostname,
          score,
          source: 'verified-page',
        });
      }

      const links = extractPageLinks(page.html, finalUrl, root.hostname, query).slice(0, 250);
      const priority = [];
      const normal = [];
      for (const link of links) {
        if (visited.has(link.url) || queued.has(link.url)) continue;
        if (visited.size + queue.length + priority.length + normal.length >= limit * 3) break;
        queued.add(link.url);
        if (link.score >= 8) priority.push(link.url);
        else normal.push(link.url);
      }
      queue.unshift(...priority.slice(0, 30));
      queue.push(...normal);
    }

    if (typeof onProgress === 'function') {
      await onProgress({
        pagesVisited: visited.size,
        pagesQueued: queue.length,
        matchesFound: matches.size,
        searchErrors: errors,
        strategy,
      });
    }
  }

  return {
    pages: [...matches.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_MATCH_PAGES),
    diagnostics: {
      pagesVisited: visited.size,
      pagesQueued: queue.length,
      errors,
      strategy,
      seedCount: seedMap.size,
    },
  };
}

function addMediaCandidate(store, rawCandidate, meta = {}) {
  try {
    const rawUrl = typeof rawCandidate === 'string' ? rawCandidate : rawCandidate?.url;
    const url = new URL(String(rawUrl || ''), meta.sourcePage || rawCandidate?.sourcePage || undefined).toString();
    if (!/^https?:\/\//i.test(url)) return;

    const candidate = {
      ...(typeof rawCandidate === 'object' ? rawCandidate : {}),
      ...meta,
      url,
      title: String(meta.title || rawCandidate?.title || '').slice(0, 180),
      sourcePage: String(meta.sourcePage || rawCandidate?.sourcePage || '').slice(0, 800),
      discoveredBy: String(meta.discoveredBy || rawCandidate?.discoveredBy || 'static'),
      contentType: String(meta.contentType || rawCandidate?.contentType || '').slice(0, 120),
      confidence: Number(meta.confidence || rawCandidate?.confidence || 50),
      explicit: Boolean(meta.explicit || rawCandidate?.explicit),
    };

    if (!looksLikeMediaUrl(url) && !isMediaContentType(candidate.contentType) && !candidate.explicit) return;
    if (store.size >= MAX_MEDIA_CANDIDATES && !store.has(url)) return;

    const current = store.get(url);
    if (!current || candidate.confidence > current.confidence || candidate.explicit) {
      store.set(url, candidate);
    }
  } catch {
    // Invalid media candidate is ignored.
  }
}

async function scanStaticMediaPage(entry, found, iframePages, explicitUrl) {
  if (looksLikeMediaUrl(entry.url)) {
    addMediaCandidate(found, entry.url, {
      title: entry.title,
      sourcePage: entry.url,
      discoveredBy: 'direct-url',
      confidence: 100,
      explicit: entry.url === explicitUrl,
    });
  }

  const page = await fetchHtmlPage(entry.url);
  if (page.mediaResponse) {
    addMediaCandidate(found, page.url, {
      title: entry.title,
      sourcePage: entry.url,
      discoveredBy: 'direct-response',
      contentType: page.contentType,
      confidence: 100,
      explicit: entry.url === explicitUrl,
    });
    return;
  }

  const title = pageTitleFromHtml(page.html) || entry.title;
  for (const candidate of extractMediaCandidatesFromText(page.html, page.url, {
    title,
    sourcePage: page.url,
    discoveredBy: 'static-html',
  })) addMediaCandidate(found, candidate);

  for (const iframeUrl of extractIframeUrls(page.html, page.url)) {
    if (iframePages.size >= 24) break;
    iframePages.set(iframeUrl, { url: iframeUrl, title: title || entry.title || '' });
  }
}

export async function discoverMediaCandidates(pageEntries, {
  explicitUrl = '',
  onProgress,
  shouldContinue,
} = {}) {
  const found = new Map();
  const iframePages = new Map();
  const pages = (Array.isArray(pageEntries) ? pageEntries : [])
    .filter((entry) => entry?.url)
    .slice(0, MAX_MATCH_PAGES);
  let staticErrors = 0;
  let scanned = 0;

  for (const entry of pages) {
    if (typeof shouldContinue === 'function' && !(await shouldContinue())) break;
    try {
      await scanStaticMediaPage(entry, found, iframePages, explicitUrl);
    } catch {
      staticErrors += 1;
    }
    scanned += 1;

    if (typeof onProgress === 'function') {
      await onProgress({
        matchPagesScanned: scanned,
        mediaFound: found.size,
        staticErrors,
      });
    }
  }

  for (const entry of [...iframePages.values()].slice(0, 10)) {
    if (typeof shouldContinue === 'function' && !(await shouldContinue())) break;
    try {
      await scanStaticMediaPage(entry, found, new Map(), '');
    } catch {
      staticErrors += 1;
    }
  }

  let browserDiagnostics = { pagesVisited: 0, protectedPages: 0, errors: 0, responseBodies: 0, iframeCount: 0 };
  try {
    const browserResult = await discoverMediaWithBrowser(pages, { shouldContinue });
    browserDiagnostics = browserResult.diagnostics;
    for (const candidate of browserResult.candidates) addMediaCandidate(found, candidate);
  } catch {
    browserDiagnostics.errors += 1;
  }

  if (typeof onProgress === 'function') {
    await onProgress({
      matchPagesScanned: scanned,
      mediaFound: found.size,
      staticErrors,
      browserDiagnostics,
    });
  }

  return {
    candidates: [...found.values()]
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, MAX_MEDIA_CANDIDATES),
    diagnostics: { staticErrors, browser: browserDiagnostics, iframePages: iframePages.size },
  };
}
