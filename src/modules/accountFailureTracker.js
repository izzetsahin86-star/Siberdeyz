import fs from 'fs/promises';
import path from 'path';

const storageDir = path.join(process.cwd(), 'data');
const sourceFile = path.join(storageDir, 'source.json');
const trackerFile = path.join(storageDir, 'account-failure-tracker.json');
const FAILURE_THRESHOLD = 3;

function emptyState() {
  return {
    threshold: FAILURE_THRESHOLD,
    accounts: {},
  };
}

async function readJson(filePath, fallback) {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeState(state) {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(trackerFile, JSON.stringify(state, null, 2));
}

async function readState() {
  const saved = await readJson(trackerFile, emptyState());

  return {
    threshold: FAILURE_THRESHOLD,
    accounts: saved && typeof saved.accounts === 'object' && saved.accounts
      ? saved.accounts
      : {},
  };
}

async function readCurrentUrlIds() {
  const saved = await readJson(sourceFile, null);
  if (!saved) return new Set();

  const sources = Array.isArray(saved.sources)
    ? saved.sources
    : (saved.id ? [saved] : []);

  return new Set(
    sources
      .filter((source) => source?.id && source.type === 'url')
      .map((source) => String(source.id))
  );
}

function publicRecord(record = {}) {
  return {
    consecutiveFailures: Math.max(0, Number(record.consecutiveFailures) || 0),
    lastStatus: String(record.lastStatus || ''),
    lastAutomaticScanAt: String(record.lastAutomaticScanAt || ''),
    persistentFailedAt: String(record.persistentFailedAt || ''),
  };
}

export async function recordAutomaticScanResults(results = [], scannedAt = new Date().toISOString()) {
  const state = await readState();

  for (const result of Array.isArray(results) ? results : []) {
    const id = String(result?.id || '').trim();
    if (!id) continue;

    const status = String(result?.health?.status || '');
    const previous = publicRecord(state.accounts[id]);

    if (status === 'failed') {
      const consecutiveFailures = previous.consecutiveFailures + 1;

      state.accounts[id] = {
        consecutiveFailures,
        lastStatus: status,
        lastAutomaticScanAt: scannedAt,
        persistentFailedAt: consecutiveFailures >= FAILURE_THRESHOLD
          ? (previous.persistentFailedAt || scannedAt)
          : '',
      };
      continue;
    }

    state.accounts[id] = {
      consecutiveFailures: 0,
      lastStatus: status,
      lastAutomaticScanAt: scannedAt,
      persistentFailedAt: '',
    };
  }

  await writeState(state);
}

export async function getPersistentFailureStatus() {
  const [state, validIds] = await Promise.all([
    readState(),
    readCurrentUrlIds(),
  ]);

  const accounts = {};
  let changed = false;

  for (const [id, rawRecord] of Object.entries(state.accounts)) {
    if (!validIds.has(id)) {
      delete state.accounts[id];
      changed = true;
      continue;
    }

    const record = publicRecord(rawRecord);
    if (record.consecutiveFailures > 0 || record.persistentFailedAt) {
      accounts[id] = record;
    }
  }

  if (changed) await writeState(state);

  const persistentIds = Object.entries(accounts)
    .filter(([, record]) => (
      record.consecutiveFailures >= FAILURE_THRESHOLD
      && Boolean(record.persistentFailedAt)
      && record.lastStatus === 'failed'
    ))
    .map(([id]) => id);

  return {
    threshold: FAILURE_THRESHOLD,
    persistentIds,
    count: persistentIds.length,
    accounts,
  };
}
