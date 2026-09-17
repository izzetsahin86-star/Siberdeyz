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

const MIN_SECONDS = 180;
const MAX_PAGES = 10;
const MAX_MEDIA = 80;
const PAGE_TIMEOUT = 16000;
const PROBE_TIMEOUT = 12000;
const TTL = 2 * 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 Siberdeyz-Media-Search/1.0';
const EXT = new Set(['m3u8', 'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mpd']);
const active = new Set();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pendingPath() { return path.join(getTenantDataDir(), 'media-search-pending.json'); }
function chromiumPath() {
  return [process.env.CHROMIUM_PATH, '/usr/bin/chromium-browser', '/usr/bin/chromium']
    .filter(Boolean).find((value) => existsSync(value)) || '/usr/bin/chromium';
}
function privateV4(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224;
}
function privateIp(ip) {
  if (net.isIP(ip) === 4) return privateV4(ip);
  if (net.isIP(ip) !== 6) return true;
  const v = String(ip).toLowerCase();
  if (!v || v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || /^fe[89ab]/.test(v) || v.startsWith('ff')) return true;
  const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateV4(mapped[1]) : false;
}
async function publicUrl(value) {
  const raw = String(value || '').trim();
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^\/+/, '');
  let parsed;
  try { parsed = new URL(normalized); } catch { const e = new Error('Gecerli bir web sitesi adresi girin.'); e.status = 400; throw e; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    const e = new Error('Yalnizca normal http veya https web adresleri taranabilir.'); e.status = 400; throw e;
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') {
    const e = new Error('Yerel veya ozel ag adresleri taranamaz.'); e.status = 400; throw e;
  }
  if (net.isIP(host)) {
    if (privateIp(host)) { const e = new Error('Yerel veya ozel IP adresleri taranamaz.'); e.status = 400; throw e; }
    return parsed;
  }
  let addresses;
  try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch { const e = new Error('Web sitesinin adresi cozumlenemedi.'); e.status = 400; throw e; }
  if (!addresses.length || addresses.some((item) => privateIp(item.address))) {
    const e = new Error('Yerel veya ozel ag hedefleri taranamaz.'); e.status = 400; throw e;
  }
  return parsed;
}
function text(value) {
  return String(value || '').toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9çğıöşü]+/gi, ' ').replace(/\s+/g, ' ').trim();
}
function clean(value) { return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 140); }
function related(root, host) {
  const a = String(root || '').toLowerCase().replace(/^www\./, '');
  const b = String(host || '').toLowerCase().replace(/^www\./, '');
  return a === b || b.endsWith('.' + a) || a.endsWith('.' + b);
}
function ext(url) { try { return new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]+)$/i)?.[1] || ''; } catch { return ''; } }
function isMedia(url) { return EXT.has(ext(url)); }
function mediaType(type) { const v = String(type || '').toLowerCase(); return v.startsWith('video/') || v.startsWith('audio/') || v.includes('mpegurl') || v.includes('dash+xml'); }
function kind(url) { const e = ext(url); return e === 'm3u8' ? 'HLS' : e === 'mpd' ? 'DASH' : (e ? e.toUpperCase() : 'VIDEO'); }
function id(url) { return 'search_' + crypto.createHash('sha1').update(url).digest('hex').slice(0, 16); }
function score(value, movie, actor) {
  const h = text(value); if (!h) return 0;
  let s = 0; const m = text(movie); const a = text(actor);
  if (m && h.includes(m)) s += 12;
  if (a && h.includes(a)) s += 10;
  for (const t of [m, a].flatMap((v) => v.split(' ')).filter((v) => v.length >= 2)) if (h.includes(t)) s += 2;
  return s;
}
function addMedia(store, raw, meta = {}) {
  if (store.size >= MAX_MEDIA) return;
  try {
    const url = new URL(String(raw || ''), meta.page || undefined).toString();
    if (!/^https?:\/\//i.test(url) || (!isMedia(url) && !meta.unknown) || store.has(url)) return;
    store.set(url, { id: id(url), url, name: clean(meta.name) || 'Arama Yayini', kind: kind(url), sourcePage: String(meta.page || '').slice(0, 500) });
  } catch {}
}
async function safeFetch(url, options = {}, redirects = 4) {
  const parsed = await publicUrl(url);
  const response = await fetch(parsed, { ...options, redirect: 'manual', headers: { 'user-agent': UA, accept: '*/*', ...(options.headers || {}) } });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location || redirects <= 0) throw new Error('Cok fazla yonlendirme var.');
    return safeFetch(new URL(location, parsed).toString(), options, redirects - 1);
  }
  return response;
}
async function readText(response, max = 700000) {
  const body = await response.text(); return body.slice(0, max);
}
async function probeHls(candidate, depth = 0) {
  const response = await safeFetch(candidate.url, { signal: AbortSignal.timeout(PROBE_TIMEOUT), headers: candidate.sourcePage ? { referer: candidate.sourcePage } : {} });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const body = await readText(response); if (!body.includes('#EXTM3U')) throw new Error('Gecerli HLS listesi degil.');
  if (depth < 2 && body.includes('#EXT-X-STREAM-INF')) {
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) if (lines[i].trim().startsWith('#EXT-X-STREAM-INF')) {
      const next = lines.slice(i + 1).find((line) => line.trim() && !line.trim().startsWith('#'));
      if (next) return probeHls({ ...candidate, url: new URL(next.trim(), response.url || candidate.url).toString() }, depth + 1);
    }
  }
  const durations = [...body.matchAll(/#EXTINF:([0-9.]+)/gi)].map((m) => Number(m[1])).filter(Number.isFinite);
  const total = durations.reduce((sum, n) => sum + n, 0); const ended = /#EXT-X-ENDLIST/i.test(body);
  return { playable: true, durationSeconds: ended && total > 0 ? total : null };
}
function probeFile(candidate) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-rw_timeout', String(PROBE_TIMEOUT * 1000), '-user_agent', UA];
    if (candidate.sourcePage) args.push('-headers', 'Referer: ' + candidate.sourcePage + '\r\n');
    args.push('-show_entries', 'format=duration', '-of', 'json', candidate.url);
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; let done = false;
    const timer = setTimeout(() => { if (!done) child.kill('SIGKILL'); }, PROBE_TIMEOUT + 1500);
    child.stdout.on('data', (c) => { out = (out + c).slice(-100000); });
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    child.on('error', (e) => { clearTimeout(timer); if (!done) { done = true; reject(e); } });
    child.on('close', (code) => {
      clearTimeout(timer); if (done) return; done = true;
      if (code !== 0) return reject(new Error(err || 'Medya acilamadi.'));
      try { const d = Number(JSON.parse(out || '{}')?.format?.duration); resolve({ playable: true, durationSeconds: Number.isFinite(d) && d > 0 ? d : null }); }
      catch { resolve({ playable: true, durationSeconds: null }); }
    });
  });
}
async function probe(candidate) {
  await publicUrl(candidate.url);
  if (ext(candidate.url) === 'm3u8') { try { return await probeHls(candidate); } catch {} }
  return probeFile(candidate);
}
async function probeAll(items) {
  const result = new Array(items.length); let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++; const item = items[i];
      try { const p = await probe(item); result[i] = { ...item, ...p, durationStatus: Number.isFinite(p.durationSeconds) ? 'known' : 'unknown' }; }
      catch (e) { result[i] = { ...item, playable: false, durationSeconds: null, durationStatus: 'failed', error: String(e?.message || 'Acilamadi').slice(0, 160) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, Math.max(1, items.length)) }, worker)); return result;
}
async function bestSearchInput(page) {
  return page.evaluate(() => {
    document.querySelectorAll('[data-siberdeyz-search-target]').forEach((el) => el.removeAttribute('data-siberdeyz-search-target'));
    let best = null;
    for (const el of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      const r = el.getBoundingClientRect(); const st = getComputedStyle(el); if (r.width < 80 || r.height < 20 || st.display === 'none' || st.visibility === 'hidden') continue;
      const type = String(el.getAttribute('type') || '').toLowerCase(); if (['password','email','tel','number','file','checkbox','radio'].includes(type)) continue;
      const desc = [el.id, el.className, el.name, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('role')].join(' ').toLowerCase();
      let score = type === 'search' ? 40 : 0; if (/search|ara|arama|query|film|movie|dizi|oyuncu/.test(desc)) score += 28; if (/\b(q|s|keyword|term)\b/.test(desc)) score += 10;
      const form = el.closest('form'); if (form) { score += 6; if (/search|ara|arama/.test([form.action, form.id, form.className].join(' ').toLowerCase())) score += 18; }
      if (!best || score > best.score) best = { el, score };
    }
    if (!best || best.score < 12) return { found: false, score: best?.score || 0 };
    best.el.setAttribute('data-siberdeyz-search-target', '1'); return { found: true, score: best.score, placeholder: best.el.getAttribute('placeholder') || '' };
  });
}
async function submitSearch(page, query) {
  const control = await bestSearchInput(page); if (!control.found) return { found: false, method: 'none', control };
  await page.focus('[data-siberdeyz-search-target="1"]');
  await page.keyboard.down('Control'); await page.keyboard.press('A'); await page.keyboard.up('Control'); await page.keyboard.type(query, { delay: 22 });
  const before = page.url(); await page.keyboard.press('Enter'); await wait(2400);
  if (page.url() === before) {
    const clicked = await page.evaluate(() => {
      const input = document.querySelector('[data-siberdeyz-search-target="1"]'); const form = input?.closest('form'); if (!input) return false;
      const nodes = form ? [...form.querySelectorAll('button,input[type="submit"]')] : [...document.querySelectorAll('button,[role="button"]')];
      const button = nodes.find((n) => /search|ara|arama|bul/.test([n.textContent,n.value,n.getAttribute('aria-label'),n.title,n.className].join(' ').toLowerCase())) || form?.querySelector('button[type="submit"],input[type="submit"]');
      if (button) { button.click(); return true; } if (form?.requestSubmit) { form.requestSubmit(); return true; } return false;
    }).catch(() => false);
    if (clicked) await wait(2200);
  }
  return { found: true, method: 'search-box', control, resultUrl: page.url() };
}
async function links(page, rootHost, movie, actor) {
  const rows = await page.evaluate(() => [...document.querySelectorAll('a[href]')].slice(0, 1600).map((a) => ({ href: a.href, text: String(a.textContent || '').replace(/\s+/g,' ').trim().slice(0,220), title: a.title || '', aria: a.getAttribute('aria-label') || '', main: Boolean(a.closest('main,[role="main"],.results,.search-results,.search-result')) })));
  const map = new Map();
  for (const row of rows) try {
    const u = new URL(row.href); if (!related(rootHost, u.hostname) || !['http:','https:'].includes(u.protocol) || /login|logout|register|privacy|terms|contact/i.test(u.pathname + u.search)) continue;
    let s = score([row.text,row.title,row.aria,u.pathname,u.search].join(' '), movie, actor); if (row.main) s += 3; if (/watch|izle|film|movie|video|episode|player/i.test(u.pathname)) s += 2; if (s <= 0) continue;
    const old = map.get(u.toString()); if (!old || s > old.score) map.set(u.toString(), { url: u.toString(), title: clean(row.text || row.title) || 'Arama Sonucu', score: s });
  } catch {}
  return [...map.values()].sort((a,b) => b.score - a.score).slice(0, MAX_PAGES);
}
async function fallbackSearch(page, startUrl, query, movie, actor) {
  const root = new URL(startUrl); const q = encodeURIComponent(query);
  for (const url of [new URL('/search?q=' + q, root), new URL('/search?query=' + q, root), new URL('/?s=' + q, root), new URL('/arama?q=' + q, root)]) {
    try { await publicUrl(url); await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }); await wait(1000); const found = await links(page, root.hostname, movie, actor); if (found.length) return { method: 'common-search-url', links: found }; } catch {}
  }
  return { method: 'none', links: [] };
}
async function domMedia(page, store, name) {
  const pageUrl = page.url();
  const urls = await page.evaluate(() => {
    const found = new Set(); const add = (v) => { if (!v) return; try { found.add(new URL(v, location.href).toString()); } catch {} };
    document.querySelectorAll('video,audio,source').forEach((n) => { add(n.currentSrc); add(n.src); add(n.getAttribute('src')); });
    document.querySelectorAll('[data-src],[data-file],[data-url]').forEach((n) => { add(n.getAttribute('data-src')); add(n.getAttribute('data-file')); add(n.getAttribute('data-url')); });
    return [...found].slice(0,100);
  }).catch(() => []);
  for (const url of urls) addMedia(store, url, { page: pageUrl, name });
}
async function playClick(page) {
  return page.evaluate(() => {
    const node = [...document.querySelectorAll('button,[role="button"],a')].find((n) => { const r = n.getBoundingClientRect(); return r.width > 12 && r.height > 12 && /\b(play|oynat|izle|watch)\b/.test([n.textContent,n.getAttribute('aria-label'),n.title,n.className].join(' ').toLowerCase()); });
    if (!node) return false; node.click(); return true;
  }).catch(() => false);
}
async function newPage(browser, store, meta) {
  const page = await browser.newPage(); await page.setUserAgent(UA); await page.setViewport({ width: 1365, height: 900 }); page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
  page.on('request', (req) => { if (isMedia(req.url())) addMedia(store, req.url(), { page: meta.page, name: meta.name }); });
  page.on('response', (res) => { const type = res.headers()['content-type'] || ''; if (isMedia(res.url()) || mediaType(type)) addMedia(store, res.url(), { page: meta.page, name: meta.name, unknown: mediaType(type) }); });
  return page;
}
async function writePending(data) { await fs.mkdir(getTenantDataDir(), { recursive: true }); await fs.writeFile(pendingPath(), JSON.stringify(data, null, 2)); }
async function readPending() {
  try { const data = JSON.parse(await fs.readFile(pendingPath(), 'utf-8')); if (!data.createdAt || Date.now() - new Date(data.createdAt).getTime() > TTL) { await deleteMediaSearchResults(data.scanId).catch(() => {}); return null; } return data; }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function scanMediaBySearch({ url, movie, actor } = {}) {
  const tenant = getTenantId(); if (active.has(tenant)) { const e = new Error('Bu kullanici icin zaten Film / Oyuncu aramasi calisiyor.'); e.status = 409; throw e; }
  const movieName = clean(movie).slice(0,120); const actorName = clean(actor).slice(0,120); if (!movieName && !actorName) { const e = new Error('Film adi veya oyuncu adi alanlarindan en az birini girin.'); e.status = 400; throw e; }
  active.add(tenant); let browser;
  try {
    const startUrl = (await publicUrl(url)).toString(); const rootHost = new URL(startUrl).hostname; const query = movieName || actorName; const store = new Map();
    browser = await puppeteer.launch({ executablePath: chromiumPath(), headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote'] });
    const meta = { page: startUrl, name: query }; const page = await newPage(browser, store, meta);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }); await wait(1100); meta.page = page.url(); meta.name = clean(await page.title().catch(() => '')) || query;
    let search = await submitSearch(page, query); meta.page = page.url(); meta.name = clean(await page.title().catch(() => '')) || query; await domMedia(page, store, meta.name);
    let resultLinks = await links(page, rootHost, movieName, actorName);
    if (!resultLinks.length && !store.size) { const fallback = await fallbackSearch(page, startUrl, query, movieName, actorName); search = { ...search, method: fallback.method }; resultLinks = fallback.links; meta.page = page.url(); meta.name = clean(await page.title().catch(() => '')) || query; await domMedia(page, store, meta.name); }
    const matched = [];
    for (const entry of resultLinks) {
      try {
        const target = await publicUrl(entry.url); if (!related(rootHost, target.hostname)) continue; meta.page = target.toString(); meta.name = entry.title;
        await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT }); await wait(1600);
        const title = clean(await page.title().catch(() => '')) || entry.title; const body = await page.evaluate(() => String(document.body?.innerText || '').slice(0,100000)).catch(() => '');
        const relevance = score(title + ' ' + body, movieName, actorName); if (relevance <= 0) continue; meta.page = page.url(); meta.name = title; await domMedia(page, store, title);
        if (await playClick(page)) { await wait(1000); await domMedia(page, store, title); } matched.push({ url: page.url(), title, relevance });
      } catch {}
      if (matched.length >= MAX_PAGES || store.size >= MAX_MEDIA) break;
    }
    await page.close().catch(() => {});
    const tested = await probeAll([...store.values()].slice(0,MAX_MEDIA)); const playable = tested.filter((x) => x.playable); const short = playable.filter((x) => Number.isFinite(x.durationSeconds) && x.durationSeconds < MIN_SECONDS);
    const visible = playable.filter((x) => !Number.isFinite(x.durationSeconds) || x.durationSeconds >= MIN_SECONDS).slice(0,50); const scanId = crypto.randomUUID();
    const data = { scanId, createdAt: new Date().toISOString(), pageUrl: startUrl, movie: movieName, actor: actorName, query, candidates: visible,
      summary: { resultLinks: resultLinks.length, matchedPages: matched.length, mediaDetected: store.size, tested: tested.length, accepted: visible.length, shortRemoved: short.length, failed: tested.filter((x) => !x.playable).length, unknownDuration: visible.filter((x) => x.durationStatus === 'unknown').length, searchBoxFound: Boolean(search.found) },
      searchMethod: search.method || 'none' };
    await writePending(data);
    return { scanId, candidates: visible, summary: data.summary, search: { movie: movieName, actor: actorName, query, method: data.searchMethod, searchBoxFound: data.summary.searchBoxFound },
      message: visible.length ? visible.length + ' uygun yayin bulundu.' : (resultLinks.length ? 'Arama sonuclari bulundu ancak kaydedilebilir yayin tespit edilemedi.' : 'Sitede bu aramayla ilgili sonuc bulunamadi.') };
  } finally { if (browser) await browser.close().catch(() => {}); active.delete(tenant); }
}

export async function saveMediaSearchSelection(scanId, ids = [], label = '') {
  const pending = await readPending(); if (!pending || pending.scanId !== String(scanId || '')) { const e = new Error('Film / Oyuncu arama sonucu bulunamadi veya suresi doldu. Yeniden arayin.'); e.status = 404; throw e; }
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String)); const selected = pending.candidates.filter((c) => wanted.has(String(c.id))); if (!selected.length) { const e = new Error('Kaydedilecek yayin secilmedi.'); e.status = 400; throw e; }
  const name = String(label || '').trim() || ('Film / Oyuncu · ' + ([pending.movie,pending.actor].filter(Boolean).join(' · ') || new URL(pending.pageUrl).hostname));
  const status = await saveWebScanPlaylistSource({ label: name, pageUrl: pending.pageUrl, channels: selected.map((c,i) => ({ name: c.name || 'Arama Yayini ' + (i+1), group: 'Web Tarama', url: c.url, webDurationSeconds: c.durationSeconds, webDurationStatus: c.durationStatus })) });
  return { ...status, saved: selected.length };
}

export async function deleteMediaSearchResults(scanId = '') {
  let pending = null; try { pending = JSON.parse(await fs.readFile(pendingPath(), 'utf-8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (scanId && pending?.scanId && String(scanId) !== String(pending.scanId)) { const e = new Error('Silinecek Film / Oyuncu arama sonucu bulunamadi.'); e.status = 404; throw e; }
  const deleted = Array.isArray(pending?.candidates) ? pending.candidates.length : 0; try { await fs.unlink(pendingPath()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return { ok: true, deleted };
}
