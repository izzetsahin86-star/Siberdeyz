import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { discoverMatchingPages, discoverMediaCandidates } from './mediaFinderPro/discovery.js';
import { mediaId, safeMediaName } from './mediaFinderPro/extractors.js';
import { probeMediaCandidate } from './mediaFinderPro/probe.js';
import { assertPublicHttpUrl } from './mediaFinderPro/urlSafety.js';
import { getTenantDataDir, getTenantId } from './tenantContext.js';
import { saveWebScanPlaylistSource } from './sourceStorage.js';

const DEFAULT_PAGE_LIMIT = 40;
const MAX_PAGE_LIMIT = 120;
const MAX_PROBE_CANDIDATES = 72;
const MIN_DISCOVERED_DURATION_SECONDS = 180;
const ACTIVE_STATUSES = new Set(['running', 'paused', 'stopping']);
const jobs = new Map();

function jobFile() {
  return path.join(getTenantDataDir(), 'media-finder-pro-job.json');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshot(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    mode: job.mode,
    status: job.status,
    phase: job.phase,
    targetUrl: job.targetUrl,
    query: job.query,
    pageLimit: job.pageLimit,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    message: job.message,
    progress: { ...(job.progress || {}) },
    diagnostics: { ...(job.diagnostics || {}) },
    matches: Array.isArray(job.matches) ? job.matches : [],
    results: Array.isArray(job.results) ? job.results : [],
  };
}

async function writeJob(job) {
  await fs.mkdir(getTenantDataDir(), { recursive: true });
  const target = jobFile();
  const temporary = target + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(job, null, 2));
  await fs.rename(temporary, target);
}

async function persist(job) {
  job.updatedAt = new Date().toISOString();
  await writeJob(job);
}

async function readStoredJob() {
  try {
    const stored = JSON.parse(await fs.readFile(jobFile(), 'utf-8'));
    if (stored && ACTIVE_STATUSES.has(stored.status) && !jobs.has(getTenantId())) {
      stored.status = 'failed';
      stored.phase = 'failed';
      stored.message = 'Sunucu yeniden basladigi icin onceki arama kesildi. Yeniden baslatin.';
    }
    return stored;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function currentJob() {
  return jobs.get(getTenantId()) || null;
}

async function waitUntilRunnable(job) {
  while (job.status === 'paused') await delay(300);
  return job.status !== 'stopping';
}

async function markStopped(job) {
  job.status = 'stopped';
  job.phase = 'stopped';
  job.message = 'Yayin Bul Pro islemi durduruldu.';
  await persist(job);
}

function initialProgress(mode) {
  return {
    pagesVisited: 0,
    pagesQueued: mode === 'search' ? 1 : 0,
    matchesFound: mode === 'direct' ? 1 : 0,
    matchPagesScanned: 0,
    mediaFound: 0,
    mediaTested: 0,
    accepted: 0,
    shortRemoved: 0,
    mediaFailed: 0,
    drmRemoved: 0,
    searchErrors: 0,
  };
}

async function testCandidates(job, candidates) {
  const selectedCandidates = candidates.slice(0, MAX_PROBE_CANDIDATES);
  const results = [];
  let cursor = 0;
  let persistChain = Promise.resolve();

  const queuePersist = () => {
    persistChain = persistChain.catch(() => {}).then(() => persist(job));
    return persistChain;
  };

  async function worker() {
    while (cursor < selectedCandidates.length) {
      if (!(await waitUntilRunnable(job))) return;

      const index = cursor;
      cursor += 1;
      const candidate = selectedCandidates[index];

      try {
        const probe = await probeMediaCandidate(candidate);
        const duration = Number(probe.durationSeconds);
        const isShort = Number.isFinite(duration)
          && duration > 0
          && duration < MIN_DISCOVERED_DURATION_SECONDS;

        if (isShort && !candidate.explicit) {
          job.progress.shortRemoved += 1;
        } else {
          results.push({
            id: mediaId(candidate.url),
            name: safeMediaName(candidate.url, results.length + 1, candidate.title),
            url: candidate.url,
            kind: probe.kind,
            sourcePage: candidate.sourcePage,
            discoveredBy: candidate.discoveredBy,
            playable: true,
            live: Boolean(probe.live),
            durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
            durationStatus: Number.isFinite(duration) && duration > 0 ? 'known' : 'unknown',
            explicitlyRequested: Boolean(candidate.explicit),
            confidence: Number(candidate.confidence || 0),
          });
        }
      } catch (error) {
        job.progress.mediaFailed += 1;
        if (/DRM/i.test(String(error?.message || ''))) job.progress.drmRemoved += 1;
      } finally {
        job.progress.mediaTested += 1;
        results.sort((left, right) => (
          Number(right.explicitlyRequested) - Number(left.explicitlyRequested)
          || right.confidence - left.confidence
          || left.name.localeCompare(right.name, 'tr')
        ));
        job.results = results.slice(0, 80);
        job.progress.accepted = job.results.length;
        await queuePersist();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(3, selectedCandidates.length) }, () => worker()));
  await persistChain.catch(() => {});
  return job.results;
}

async function runJob(job) {
  try {
    let pages;

    if (job.mode === 'search') {
      job.phase = 'searching';
      job.message = 'Site aramasi, sitemap ve dinamik arama motoru birlikte calisiyor...';
      await persist(job);

      const search = await discoverMatchingPages(job.targetUrl, job.query, job.pageLimit, {
        shouldContinue: () => waitUntilRunnable(job),
        async onProgress(progress) {
          Object.assign(job.progress, progress);
          job.message = job.progress.matchesFound > 0
            ? job.progress.matchesFound + ' ilgili sayfa bulundu; arama suruyor...'
            : job.progress.pagesVisited + ' sayfa kontrol edildi; eslesme araniyor...';
          await persist(job);
        },
      });

      if (job.status === 'stopping') {
        await markStopped(job);
        return;
      }

      pages = search.pages;
      job.matches = pages.map((page, index) => ({
        id: 'match_' + crypto.createHash('sha1').update(page.url).digest('hex').slice(0, 12),
        url: page.url,
        title: page.title || ('Eslesen Sayfa ' + (index + 1)),
        source: page.source,
      }));
      job.progress.matchesFound = pages.length;
      job.diagnostics.search = search.diagnostics;

      if (!pages.length) {
        job.status = 'completed';
        job.phase = 'completed';
        job.message = '"' + job.query + '" icin eslesen yayin sayfasi bulunamadi.';
        await persist(job);
        return;
      }
    } else {
      pages = [{
        url: job.targetUrl,
        title: new URL(job.targetUrl).hostname,
        source: 'direct',
      }];
      job.matches = [{
        id: 'match_' + crypto.createHash('sha1').update(job.targetUrl).digest('hex').slice(0, 12),
        url: job.targetUrl,
        title: 'Yapistirilan yayin veya sayfa baglantisi',
        source: 'direct',
      }];
      job.progress.matchesFound = 1;
    }

    job.phase = 'discovering';
    job.message = job.mode === 'direct'
      ? 'Baglanti; HTML, oynatici, iframe ve ag istekleriyle inceleniyor...'
      : job.matches.length + ' ilgili sayfada yayin kaynaklari araniyor...';
    await persist(job);

    const discovery = await discoverMediaCandidates(pages, {
      explicitUrl: job.mode === 'direct' ? job.targetUrl : '',
      shouldContinue: () => waitUntilRunnable(job),
      async onProgress(progress) {
        Object.assign(job.progress, progress);
        job.message = job.progress.mediaFound > 0
          ? job.progress.mediaFound + ' yayin adayi bulundu; sayfalar inceleniyor...'
          : 'Oynatici, iframe ve ag istekleri inceleniyor...';
        await persist(job);
      },
    });

    if (job.status === 'stopping') {
      await markStopped(job);
      return;
    }

    job.progress.mediaFound = discovery.candidates.length;
    job.diagnostics.discovery = discovery.diagnostics;

    if (!discovery.candidates.length) {
      job.status = 'completed';
      job.phase = 'completed';
      job.message = discovery.diagnostics?.browser?.protectedPages > 0
        ? 'Site dogrulama/koruma sayfasi gosterdi. Koruma asilmadan yayin bulunamadi.'
        : 'Sayfa incelendi ancak erisilebilir bir video yayin kaynagi bulunamadi.';
      await persist(job);
      return;
    }

    job.phase = 'testing';
    job.message = discovery.candidates.length + ' yayin adayi guvenli sekilde dogrulaniyor...';
    await persist(job);

    const results = await testCandidates(job, discovery.candidates);

    if (job.status === 'stopping') {
      await markStopped(job);
      return;
    }

    job.status = 'completed';
    job.phase = 'completed';
    job.message = results.length > 0
      ? results.length + ' calisan yayin bulundu ve listelendi.'
      : 'Yayin adaylari bulundu ancak hicbiri oynatilabilir olarak dogrulanamadi.';
    await persist(job);
  } catch (error) {
    job.status = 'failed';
    job.phase = 'failed';
    job.message = String(error?.message || 'Yayin Bul Pro islemi tamamlanamadi.').slice(0, 320);
    await persist(job).catch(() => {});
  } finally {
    jobs.delete(job.tenantId);
  }
}

export async function startMediaFinderPro({ mode, url, query, limit } = {}) {
  const tenantId = getTenantId();
  const active = jobs.get(tenantId);
  if (active && ACTIVE_STATUSES.has(active.status)) {
    const error = new Error('Bu kullanici icin zaten bir Yayin Bul Pro islemi calisiyor.');
    error.status = 409;
    throw error;
  }

  const selectedMode = mode === 'direct' ? 'direct' : 'search';
  const targetUrl = (await assertPublicHttpUrl(url)).toString();
  const cleanQuery = String(query || '').replace(/\s+/g, ' ').trim();
  if (selectedMode === 'search' && cleanQuery.length < 2) {
    const error = new Error('Film veya oyuncu adi en az 2 karakter olmali.');
    error.status = 400;
    throw error;
  }

  const requestedLimit = Number(limit);
  const pageLimit = selectedMode === 'direct'
    ? 1
    : (Number.isFinite(requestedLimit)
      ? Math.min(MAX_PAGE_LIMIT, Math.max(10, Math.floor(requestedLimit)))
      : DEFAULT_PAGE_LIMIT);

  const now = new Date().toISOString();
  const job = {
    tenantId,
    jobId: 'pro_' + crypto.randomBytes(12).toString('hex'),
    mode: selectedMode,
    status: 'running',
    phase: 'queued',
    targetUrl,
    query: selectedMode === 'search' ? cleanQuery : '',
    pageLimit,
    createdAt: now,
    updatedAt: now,
    message: selectedMode === 'search'
      ? 'Yayin Bul Pro site aramasini hazirliyor...'
      : 'Yayin Bul Pro baglantiyi hazirliyor...',
    progress: initialProgress(selectedMode),
    diagnostics: {},
    matches: [],
    results: [],
  };

  jobs.set(tenantId, job);
  await persist(job);
  setImmediate(() => runJob(job).catch(() => {}));
  return snapshot(job);
}

export async function getMediaFinderProStatus() {
  const live = currentJob();
  return snapshot(live || await readStoredJob());
}

export async function pauseMediaFinderPro() {
  const job = currentJob();
  if (!job || job.status !== 'running') {
    const error = new Error('Duraklatilabilecek aktif bir Yayin Bul Pro islemi yok.');
    error.status = 404;
    throw error;
  }

  job.status = 'paused';
  job.message = 'Yayin Bul Pro duraklatildi.';
  await persist(job);
  return snapshot(job);
}

export async function resumeMediaFinderPro() {
  const job = currentJob();
  if (!job || job.status !== 'paused') {
    const error = new Error('Devam ettirilecek duraklatilmis bir islem yok.');
    error.status = 404;
    throw error;
  }

  job.status = 'running';
  job.message = 'Yayin Bul Pro calismaya devam ediyor...';
  await persist(job);
  return snapshot(job);
}

export async function stopMediaFinderPro() {
  const job = currentJob();
  if (!job || !ACTIVE_STATUSES.has(job.status)) return snapshot(await readStoredJob());

  job.status = 'stopping';
  job.message = 'Yayin Bul Pro durduruluyor...';
  await persist(job);
  return snapshot(job);
}

export async function saveMediaFinderProSelection(jobId, candidateIds = [], label = '') {
  const stored = currentJob() || await readStoredJob();
  if (!stored || stored.jobId !== String(jobId || '')) {
    const error = new Error('Yayin Bul Pro sonucu bulunamadi.');
    error.status = 404;
    throw error;
  }
  if (ACTIVE_STATUSES.has(stored.status)) {
    const error = new Error('Arama tamamlanmadan sonuclar kaydedilemez.');
    error.status = 409;
    throw error;
  }

  const ids = new Set((Array.isArray(candidateIds) ? candidateIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean));
  const selected = (stored.results || []).filter((candidate) => ids.has(candidate.id));
  if (!selected.length) {
    const error = new Error('Kaydedilecek en az bir yayin secin.');
    error.status = 400;
    throw error;
  }

  const sourceLabel = String(label || '').trim() || (
    stored.mode === 'search'
      ? ('Yayin Bul Pro · ' + stored.query)
      : ('Yayin Bul Pro · ' + new URL(stored.targetUrl).hostname)
  );

  const status = await saveWebScanPlaylistSource({
    label: sourceLabel,
    pageUrl: stored.targetUrl,
    channels: selected.map((candidate, index) => ({
      name: candidate.name || ('Yayin ' + (index + 1)),
      group: 'Yayin Bul Pro',
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

export async function deleteMediaFinderProResults(jobId) {
  const stored = currentJob() || await readStoredJob();
  if (!stored || stored.jobId !== String(jobId || '')) {
    const error = new Error('Yayin Bul Pro sonucu bulunamadi.');
    error.status = 404;
    throw error;
  }
  if (ACTIVE_STATUSES.has(stored.status)) {
    const error = new Error('Calisan aramanin sonuclari silinemez. Once islemi durdurun.');
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
