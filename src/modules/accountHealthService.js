import fs from 'fs/promises';
import path from 'path';

const storageDir = path.join(process.cwd(), 'data');
const sourceFile = path.join(storageDir, 'source.json');
const healthFile = path.join(storageDir, 'account-health.json');
const SCAN_TIMEOUT_MS = 6000;
const MAX_BATCH_SIZE = 100;
const SCAN_CONCURRENCY = 10;

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function readSources() {
  const saved = await readJson(sourceFile, null);
  if (!saved) return [];

  if (Array.isArray(saved.sources)) {
    return saved.sources.filter((source) => source && source.id);
  }

  return saved.id ? [saved] : [];
}

async function readHealthState() {
  const saved = await readJson(healthFile, { accounts: {} });
  return {
    accounts: saved && typeof saved.accounts === 'object' && saved.accounts
      ? saved.accounts
      : {},
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function toExpiryIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';

  try {
    return new Date(seconds * 1000).toISOString();
  } catch {
    return '';
  }
}

function publicRecord(record = {}) {
  return {
    status: String(record.status || 'unscanned'),
    activeConnections: toNumber(record.activeConnections),
    maxConnections: toNumber(record.maxConnections),
    expiresAt: String(record.expiresAt || ''),
    checkedAt: String(record.checkedAt || ''),
    message: String(record.message || ''),
    protocol: String(record.protocol || ''),
  };
}

function makeRecord(overrides = {}) {
  return publicRecord({
    status: 'failed',
    activeConnections: 0,
    maxConnections: 0,
    expiresAt: '',
    checkedAt: new Date().toISOString(),
    message: '',
    protocol: '',
    ...overrides,
  });
}

function getXtreamApiUrl(source) {
  try {
    const parsed = new URL(String(source?.url || ''));
    const username = parsed.searchParams.get('username');
    const password = parsed.searchParams.get('password');

    if (!username || !password) return '';

    const pathname = parsed.pathname;
    if (!/\/(?:get|player_api)\.php$/i.test(pathname)) return '';

    parsed.pathname = pathname.replace(/\/(?:get|player_api)\.php$/i, '/player_api.php');
    parsed.search = '';
    parsed.searchParams.set('username', username);
    parsed.searchParams.set('password', password);
    return parsed.toString();
  } catch {
    return '';
  }
}

async function scanXtreamSource(source, apiUrl) {
  const response = await fetch(apiUrl, {
    headers: {
      'user-agent': 'Siberdeyz-IPTV-Account-Scanner/1.0',
      accept: 'application/json,text/plain,*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });

  if (!response.ok) {
    return makeRecord({
      status: 'failed',
      protocol: 'xtream',
      message: 'HTTP ' + response.status,
    });
  }

  const data = await response.json();
  const userInfo = data?.user_info || {};
  const rawStatus = String(userInfo.status || '').trim();
  const normalizedStatus = rawStatus.toLocaleLowerCase('tr-TR');
  const activeConnections = toNumber(userInfo.active_cons);
  const maxConnections = toNumber(userInfo.max_connections);
  const expiresAt = toExpiryIso(userInfo.exp_date);
  const expiryMs = expiresAt ? Date.parse(expiresAt) : 0;
  const isExpired = normalizedStatus === 'expired' || (expiryMs > 0 && expiryMs <= Date.now());
  const isActive = normalizedStatus === 'active' && !isExpired;

  if (isExpired) {
    return makeRecord({
      status: 'expired',
      activeConnections,
      maxConnections,
      expiresAt,
      protocol: 'xtream',
      message: 'Hesap suresi dolmus.',
    });
  }

  if (isActive) {
    return makeRecord({
      status: 'active',
      activeConnections,
      maxConnections,
      expiresAt,
      protocol: 'xtream',
      message: 'Hesap calisiyor.',
    });
  }

  return makeRecord({
    status: 'failed',
    activeConnections,
    maxConnections,
    expiresAt,
    protocol: 'xtream',
    message: rawStatus ? ('Durum: ' + rawStatus) : 'Hesap dogrulanamadi.',
  });
}

async function scanGenericUrl(source) {
  const response = await fetch(String(source?.url || ''), {
    method: 'GET',
    headers: {
      'user-agent': 'Siberdeyz-IPTV-Account-Scanner/1.0',
      range: 'bytes=0-1023',
      accept: 'application/x-mpegURL,text/plain,*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  });

  if (response.body) {
    try {
      await response.body.cancel();
    } catch {
      // Baslik kontrolu yeterli; govde iptali kritik degil.
    }
  }

  if (response.ok || response.status === 206) {
    return makeRecord({
      status: 'active',
      protocol: 'playlist',
      message: 'Liste URL erisilebilir.',
    });
  }

  return makeRecord({
    status: 'failed',
    protocol: 'playlist',
    message: 'HTTP ' + response.status,
  });
}

async function scanSource(source) {
  if (!source || source.type === 'file') {
    return makeRecord({
      status: 'unsupported',
      protocol: 'file',
      message: 'Dosya hesabi taranmaz.',
    });
  }

  try {
    const apiUrl = getXtreamApiUrl(source);
    if (apiUrl) return await scanXtreamSource(source, apiUrl);
    return await scanGenericUrl(source);
  } catch (error) {
    const name = String(error?.name || '');
    const timeout = name === 'TimeoutError' || name === 'AbortError';

    return makeRecord({
      status: 'failed',
      protocol: getXtreamApiUrl(source) ? 'xtream' : 'playlist',
      message: timeout ? 'Baglanti zaman asimina ugradi.' : 'Hesaba ulasilamadi.',
    });
  }
}

export async function getAccountHealth() {
  const [sources, health] = await Promise.all([
    readSources(),
    readHealthState(),
  ]);
  const validIds = new Set(sources.map((source) => String(source.id)));
  const accounts = {};

  for (const [id, record] of Object.entries(health.accounts)) {
    if (validIds.has(id)) accounts[id] = publicRecord(record);
  }

  return {
    accounts,
    total: sources.length,
  };
}

export async function scanAccount(sourceId) {
  const id = String(sourceId || '').trim();
  const sources = await readSources();
  const source = sources.find((item) => String(item.id) === id);

  if (!source) {
    const error = new Error('Hesap bulunamadi.');
    error.status = 404;
    throw error;
  }

  const record = await scanSource(source);
  const health = await readHealthState();
  health.accounts[id] = record;
  await writeJson(healthFile, health);

  return {
    id,
    health: publicRecord(record),
  };
}

export async function scanAccounts(sourceIds = []) {
  const ids = Array.from(new Set(
    (Array.isArray(sourceIds) ? sourceIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )).slice(0, MAX_BATCH_SIZE);

  if (ids.length === 0) {
    return { results: [] };
  }

  const sources = await readSources();
  const sourceMap = new Map(sources.map((source) => [String(source.id), source]));
  const results = new Array(ids.length);
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const index = cursor;
      cursor += 1;

      const id = ids[index];
      const source = sourceMap.get(id);

      if (!source) {
        results[index] = {
          id,
          health: makeRecord({
            status: 'failed',
            message: 'Hesap bulunamadi.',
          }),
        };
        continue;
      }

      results[index] = {
        id,
        health: await scanSource(source),
      };
    }
  }

  const workers = Array.from(
    { length: Math.min(SCAN_CONCURRENCY, ids.length) },
    () => worker()
  );

  await Promise.all(workers);

  const health = await readHealthState();
  for (const result of results) {
    health.accounts[result.id] = publicRecord(result.health);
  }
  await writeJson(healthFile, health);

  return {
    results: results.map((result) => ({
      id: result.id,
      health: publicRecord(result.health),
    })),
  };
}


export async function removeAccountHealth(sourceId = '') {
  const id = String(sourceId || '').trim();

  if (!id) {
    try {
      await fs.unlink(healthFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    return;
  }

  const health = await readHealthState();
  if (!(id in health.accounts)) return;

  delete health.accounts[id];
  await writeJson(healthFile, health);
}
