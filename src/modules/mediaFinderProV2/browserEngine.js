import { existsSync } from 'fs';
import puppeteer from 'puppeteer-core';
import { withHeavyTask } from '../resourceBudget.js';
import { assertPublicHttpUrl, MEDIA_FINDER_USER_AGENT } from '../mediaFinderPro/urlSafety.js';
import { isMediaContentType, looksLikeMediaUrl, mediaKind } from '../mediaFinderPro/extractors.js';
import { addAdvancedCandidate, extractEmbeddedMediaUrls, collectFrameResources, adaptiveListen } from './advancedDiscovery.js';

const PAGE_TIMEOUT = 20000;
const MAX_PAGES = 30;
const MAX_CANDIDATES = 220;

function chromiumPath() {
  return [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium']
    .filter(Boolean).find(existsSync) || '/usr/bin/chromium';
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function addCandidate(store, url, meta = {}) {
  try {
    const value = new URL(String(url || ''), meta.sourcePage || undefined).toString();
    if (!/^https?:\/\//i.test(value) || store.size >= MAX_CANDIDATES) return;
    const type = String(meta.contentType || '').toLowerCase();
    if (!looksLikeMediaUrl(value) && !isMediaContentType(type) && !/m3u8|\.mpd(?:\?|$)|videoplayback|manifest/i.test(value)) return;
    const old = store.get(value);
    const next = {
      url: value,
      title: String(meta.title || '').slice(0, 180),
      sourcePage: String(meta.sourcePage || '').slice(0, 900),
      discoveredBy: String(meta.discoveredBy || 'v2-network'),
      contentType: type.slice(0, 120),
      confidence: Number(meta.confidence || 80),
      kind: mediaKind(value, type),
    };
    if (!old || next.confidence > old.confidence) store.set(value, next);
  } catch {}
}

async function clickPlayers(page) {
  return page.evaluate(() => {
    const selectors = [
      'video', '[aria-label*="play" i]', '[title*="play" i]', '.vjs-big-play-button',
      '.jw-icon-playback', '.plyr__control--overlaid', '[class*="play-button" i]',
      '[class*="playButton" i]', 'button[class*="play" i]'
    ];
    let clicked = 0;
    for (const selector of selectors) {
      for (const el of [...document.querySelectorAll(selector)].slice(0, 8)) {
        try {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          if (el.tagName === 'VIDEO') {
            el.muted = true;
            const p = el.play?.();
            if (p?.catch) p.catch(() => {});
          } else {
            el.click();
          }
          clicked += 1;
        } catch {}
      }
    }
    window.scrollTo(0, Math.min(document.body.scrollHeight, 900));
    return clicked;
  }).catch(() => 0);
}

async function scanPage(browser, entry, candidates, diagnostics, shouldContinue) {
  if (shouldContinue && !(await shouldContinue())) return;
  await assertPublicHttpUrl(entry.url);
  const page = await browser.newPage();
  diagnostics.pagesOpened += 1;
  const sourcePage = entry.url;
  let title = entry.title || '';
  const bodyReads = [];

  try {
    await page.setUserAgent(MEDIA_FINDER_USER_AGENT);
    await page.setViewport({ width: 1365, height: 900 });
    await page.setRequestInterception(true);
    const safeHosts = new Map();
    page.on('request', async (request) => {
      const url = request.url();
      if (!/^https?:\/\//i.test(url)) {
        request.continue().catch(() => {});
        return;
      }
      try {
        const host = new URL(url).hostname;
        if (!safeHosts.has(host)) safeHosts.set(host, assertPublicHttpUrl(url).then(() => true));
        await safeHosts.get(host);
        addCandidate(candidates, url, { sourcePage, title, discoveredBy: 'v2-request', confidence: 84 });
        request.continue().catch(() => {});
      } catch {
        diagnostics.blockedRequests += 1;
        request.abort('blockedbyclient').catch(() => {});
      }
    });
    page.on('response', (response) => {
      const headers = response.headers();
      const type = headers['content-type'] || '';
      addCandidate(candidates, response.url(), {
        sourcePage, title, contentType: type, discoveredBy: 'v2-response',
        confidence: isMediaContentType(type) ? 98 : 88,
      });
      if (bodyReads.length < 24 && /mpegurl|dash\+xml|json|javascript|text\/plain/i.test(type)) {
        bodyReads.push(response.text().then((text) => {
          for (const url of extractEmbeddedMediaUrls(text, response.url())) {
            addAdvancedCandidate(candidates, url, { sourcePage, title, contentType: type, discoveredBy: 'v2-response-body-advanced', confidence: 94 });
          }
        }).catch(() => {}));
      }
    });

    await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }).catch(() => {});
    const pageTitle = await page.evaluate(() => {
      const video = document.querySelector('video');
      const meta = document.querySelector('meta[property="og:title"],meta[name="twitter:title"]');
      return String(meta?.content || video?.getAttribute('title') || document.title || '').trim();
    }).catch(() => '');
    if (pageTitle) title = pageTitle.slice(0, 180);
    await sleep(900);
    diagnostics.playerClicks += await clickPlayers(page);
    await adaptiveListen({ page, candidates, diagnostics, clickMain: clickPlayers, sleep, shouldContinue });

    const performanceUrls = await page.evaluate(() => performance.getEntriesByType('resource').map((x) => x.name)).catch(() => []);
    for (const url of performanceUrls) addCandidate(candidates, url, { sourcePage, title, discoveredBy: 'v2-performance', confidence: 82 });

    const frames = page.frames().map((frame) => frame.url()).filter((url) => /^https?:\/\//i.test(url));
    diagnostics.iframes = Math.max(diagnostics.iframes, Math.max(0, frames.length - 1));
    await collectFrameResources(page, candidates, { sourcePage, title });
    await Promise.allSettled(bodyReads);
  } finally {
    await page.close().catch(() => {});
  }
}

async function deepDiscoverV2Unlocked(entries, { shouldContinue, onProgress } = {}) {
  const candidates = new Map();
  const diagnostics = { pagesOpened: 0, playerClicks: 0, iframes: 0, blockedRequests: 0, errors: 0 };
  const browser = await puppeteer.launch({
    executablePath: chromiumPath(), headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--autoplay-policy=no-user-gesture-required'],
  });
  try {
    for (const entry of (entries || []).slice(0, MAX_PAGES)) {
      try { await scanPage(browser, entry, candidates, diagnostics, shouldContinue); }
      catch { diagnostics.errors += 1; }
      if (onProgress) await onProgress({ ...diagnostics, candidates: candidates.size });
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { candidates: [...candidates.values()], diagnostics };
}

export async function deepDiscoverV2(entries, options = {}) {
  return withHeavyTask(() => deepDiscoverV2Unlocked(entries, options));
}
