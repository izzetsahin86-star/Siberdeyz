import { existsSync } from 'fs';
import puppeteer from 'puppeteer-core';
import {
  extractMediaCandidatesFromText,
  isMediaContentType,
  looksLikeMediaUrl,
  queryScore,
} from './extractors.js';
import {
  assertPublicHttpUrl,
  canonicalPageUrl,
  isSameSite,
  MEDIA_FINDER_USER_AGENT,
} from './urlSafety.js';

const PAGE_TIMEOUT_MS = 15_000;
const SETTLE_MS = 2_800;
const MAX_RESPONSE_BODIES = 28;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || '/usr/bin/chromium';
}

async function launchBrowser() {
  return puppeteer.launch({
    executablePath: chromiumPath(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-popup-blocking',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

async function configureSafePage(page, { onRequestUrl } = {}) {
  const hostSafety = new Map();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent(MEDIA_FINDER_USER_AGENT);
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

    if (!/^https?:\/\//i.test(url)) {
      request.abort().catch(() => {});
      return;
    }

    if (typeof onRequestUrl === 'function') onRequestUrl(url, resourceType);

    if (resourceType === 'image' || resourceType === 'font') {
      request.abort().catch(() => {});
      return;
    }

    try {
      const host = new URL(url).hostname;
      if (!hostSafety.has(host)) {
        hostSafety.set(host, assertPublicHttpUrl(url).then(() => true).catch(() => false));
      }

      if (await hostSafety.get(host)) request.continue().catch(() => {});
      else request.abort().catch(() => {});
    } catch {
      request.abort().catch(() => {});
    }
  });
}

function protectionDetected(title, body, linkCount, mediaCount) {
  const text = (String(title || '') + ' ' + String(body || '')).toLowerCase();
  return (
    /checking your browser|verify you are human|cloudflare ray id|cf-chl-|attention required|captcha/i.test(text)
    || (/please wait|just a moment/.test(text) && linkCount < 3 && mediaCount === 0)
  );
}

export async function discoverBrowserSearch(siteUrl, query) {
  const browser = await launchBrowser();
  const root = new URL(siteUrl);
  const results = new Map();

  try {
    const page = await browser.newPage();
    await configureSafePage(page);
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await delay(500);

    const marker = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')];
      let best = null;

      for (const element of candidates) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 60 || rect.height < 18 || style.display === 'none' || style.visibility === 'hidden') continue;

        const type = String(element.getAttribute('type') || '').toLowerCase();
        if (['password', 'email', 'tel', 'file', 'checkbox', 'radio'].includes(type)) continue;

        const description = [
          type,
          element.id,
          element.className,
          element.getAttribute('name'),
          element.getAttribute('placeholder'),
          element.getAttribute('aria-label'),
        ].join(' ').toLowerCase();

        let score = type === 'search' ? 45 : 0;
        if (/search|ara|arama|query|film|movie|dizi|oyuncu|keyword/.test(description)) score += 35;
        if (element.closest('form')) score += 8;
        if (!best || score > best.score) best = { element, score };
      }

      if (!best || best.score < 18) return false;
      best.element.setAttribute('data-siberdeyz-pro-search', '1');
      return true;
    });

    if (!marker) return { method: 'browser-none', pages: [] };

    await page.focus('[data-siberdeyz-pro-search="1"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('A');
    await page.keyboard.up('Control');
    await page.keyboard.type(query, { delay: 14 });

    const before = page.url();
    await page.keyboard.press('Enter');
    await delay(1_900);

    if (page.url() === before) {
      await page.evaluate(() => {
        const input = document.querySelector('[data-siberdeyz-pro-search="1"]');
        const form = input?.closest('form');
        const button = form?.querySelector('button[type="submit"],input[type="submit"]');
        if (button instanceof HTMLElement) button.click();
        else if (form?.requestSubmit) form.requestSubmit();
      }).catch(() => {});
      await delay(1_500);
    }

    const rows = await page.evaluate(() => [...document.querySelectorAll('a[href]')].slice(0, 2_000).map((anchor) => ({
      href: anchor.href,
      text: String(anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      title: String(anchor.getAttribute('title') || '').slice(0, 180),
      inResults: Boolean(anchor.closest('main,[role="main"],.results,.search-results,.search-result,[class*="result"]')),
    })));

    for (const row of rows) {
      try {
        const url = canonicalPageUrl(row.href);
        if (!url) continue;
        const parsed = new URL(url);
        if (!isSameSite(root.hostname, parsed.hostname)) continue;

        let score = queryScore(row.text + ' ' + row.title + ' ' + parsed.pathname + parsed.search, query);
        if (row.inResults) score += 10;
        if (/watch|izle|film|movie|video|episode|bolum|dizi/i.test(parsed.pathname)) score += 7;
        if (score < 8) continue;

        const current = results.get(url);
        if (!current || score > current.score) {
          results.set(url, {
            url,
            title: row.text || row.title || 'Arama Sonucu',
            score,
            source: 'browser-search',
          });
        }
      } catch {
        // Invalid browser result is ignored.
      }
    }

    const currentUrl = canonicalPageUrl(page.url());
    const currentTitle = String(await page.title().catch(() => '')).trim();
    const body = await page.evaluate(() => String(document.body?.innerText || '').slice(0, 150_000)).catch(() => '');
    const currentScore = queryScore(currentTitle + ' ' + body + ' ' + currentUrl, query);
    if (currentUrl && isSameSite(root.hostname, new URL(currentUrl).hostname) && currentScore >= 18) {
      results.set(currentUrl, {
        url: currentUrl,
        title: currentTitle || 'Arama Sonucu',
        score: currentScore + 8,
        source: 'browser-search-page',
      });
    }

    return {
      method: 'browser-search',
      pages: [...results.values()].sort((left, right) => right.score - left.score).slice(0, 30),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function discoverMediaWithBrowser(pageEntries, { shouldContinue } = {}) {
  const entries = Array.isArray(pageEntries) ? pageEntries.slice(0, 16) : [];
  if (!entries.length) return { candidates: [], diagnostics: { pagesVisited: 0, protectedPages: 0, errors: 0 } };

  const browser = await launchBrowser();
  const found = new Map();
  const diagnostics = { pagesVisited: 0, protectedPages: 0, errors: 0, responseBodies: 0, iframeCount: 0 };

  const add = (rawUrl, meta = {}) => {
    try {
      const url = new URL(String(rawUrl || ''), meta.sourcePage || undefined).toString();
      if (!/^https?:\/\//i.test(url)) return;
      if (!looksLikeMediaUrl(url) && !meta.allowUnknown) return;
      if (found.size >= 160) return;

      const existing = found.get(url);
      if (!existing || Number(meta.confidence || 0) > Number(existing.confidence || 0)) {
        found.set(url, {
          url,
          title: String(meta.title || '').slice(0, 180),
          sourcePage: String(meta.sourcePage || '').slice(0, 800),
          discoveredBy: String(meta.discoveredBy || 'browser'),
          contentType: String(meta.contentType || '').slice(0, 120),
          confidence: Number(meta.confidence || 75),
          explicit: Boolean(meta.explicit),
        });
      }
    } catch {
      // Invalid media URL is ignored.
    }
  };

  try {
    for (const entry of entries) {
      if (typeof shouldContinue === 'function' && !(await shouldContinue())) break;

      const page = await browser.newPage();
      const responseTasks = [];
      let currentTitle = entry.title || '';

      try {
        await configureSafePage(page, {
          onRequestUrl(url) {
            if (looksLikeMediaUrl(url)) {
              add(url, {
                title: currentTitle,
                sourcePage: entry.url,
                discoveredBy: 'browser-request',
                confidence: 90,
              });
            }
          },
        });

        page.on('response', (response) => {
          const headers = response.headers();
          const contentType = String(headers['content-type'] || '').toLowerCase();
          const url = response.url();
          const resourceType = response.request().resourceType();

          if (looksLikeMediaUrl(url) || isMediaContentType(contentType)) {
            add(url, {
              title: currentTitle,
              sourcePage: entry.url,
              discoveredBy: 'browser-response',
              contentType,
              allowUnknown: isMediaContentType(contentType),
              confidence: 96,
            });
          }

          const inspectBody = diagnostics.responseBodies < MAX_RESPONSE_BODIES
            && ['xhr', 'fetch', 'script'].includes(resourceType)
            && (contentType.includes('json') || contentType.includes('javascript') || contentType.startsWith('text/'));
          if (!inspectBody) return;

          diagnostics.responseBodies += 1;
          responseTasks.push(response.text()
            .then((body) => {
              if (!body || body.length > 2_500_000) return;
              for (const candidate of extractMediaCandidatesFromText(body, response.url(), {
                title: currentTitle,
                sourcePage: entry.url,
                discoveredBy: 'browser-response-body',
              })) add(candidate.url, candidate);
            })
            .catch(() => {}));
        });

        try {
          await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
        } catch {
          // Network events may still have revealed a direct media URL.
        }

        diagnostics.pagesVisited += 1;
        currentTitle = String(await page.title().catch(() => currentTitle)).trim() || currentTitle;

        const signals = await page.evaluate(() => {
          const media = new Set();
          document.querySelectorAll('video,audio,source,[data-file],[data-src]').forEach((element) => {
            [
              element.currentSrc,
              element.src,
              element.getAttribute?.('src'),
              element.getAttribute?.('data-src'),
              element.getAttribute?.('data-file'),
            ].filter(Boolean).forEach((value) => media.add(String(value)));
          });

          document.querySelectorAll('video,audio').forEach((element) => {
            try {
              element.muted = true;
              element.preload = 'auto';
              element.play().catch(() => {});
            } catch {
              // Player activation is best effort.
            }
          });

          const selectors = [
            '.vjs-big-play-button', '.jw-icon-playback', '.plyr__control--overlaid',
            '[data-plyr="play"]', 'button[aria-label*="play" i]',
            '[role="button"][aria-label*="play" i]', 'button[title*="play" i]',
          ];
          let clicked = 0;
          for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
              if (clicked >= 3) break;
              try { element.click(); clicked += 1; } catch { /* best effort */ }
            }
            if (clicked >= 3) break;
          }

          window.scrollTo(0, Math.min(document.body?.scrollHeight || 0, 5000));
          return {
            title: String(document.title || ''),
            body: String(document.body?.innerText || '').slice(0, 2_500),
            media: [...media],
            links: document.querySelectorAll('a[href]').length,
            iframes: document.querySelectorAll('iframe').length,
          };
        }).catch(() => ({ title: currentTitle, body: '', media: [], links: 0, iframes: 0 }));

        currentTitle = signals.title || currentTitle;
        diagnostics.iframeCount += Number(signals.iframes) || 0;
        if (protectionDetected(currentTitle, signals.body, signals.links, signals.media.length)) {
          diagnostics.protectedPages += 1;
        }

        for (const value of signals.media) {
          add(value, {
            title: currentTitle,
            sourcePage: entry.url,
            discoveredBy: 'browser-dom',
            confidence: 92,
          });
        }

        await delay(SETTLE_MS);

        const late = await page.evaluate(() => {
          const urls = new Set();
          for (const item of performance.getEntriesByType('resource')) {
            if (item?.name) urls.add(String(item.name));
          }
          document.querySelectorAll('video,audio,source').forEach((element) => {
            [element.currentSrc, element.src, element.getAttribute?.('src')]
              .filter(Boolean)
              .forEach((value) => urls.add(String(value)));
          });
          return [...urls];
        }).catch(() => []);

        for (const value of late) {
          if (looksLikeMediaUrl(value)) {
            add(value, {
              title: currentTitle,
              sourcePage: entry.url,
              discoveredBy: 'browser-performance',
              confidence: 88,
            });
          }
        }

        await Promise.allSettled(responseTasks);
      } catch {
        diagnostics.errors += 1;
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return { candidates: [...found.values()], diagnostics };
}
