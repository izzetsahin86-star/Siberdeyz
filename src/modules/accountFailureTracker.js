import fs from 'fs/promises';
import path from 'path';
import { getAppSettings } from './appSettingsService.js';
import { getTenantDataDir } from './tenantContext.js';

function getStorageDir() {
  return getTenantDataDir();
}

function getSourceFile() {
  return path.join(getStorageDir(), 'source.json');
}

function getTrackerFile() {
  return path.join(getStorageDir(), 'account-failure-tracker.json');
}

async function getFailureThreshold() {
  const settings = await getAppSettings();
  return Number(settings.failureThreshold) || 3;
}

function emptyState(threshold) {
  return { threshold, accounts: {} };
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
  await fs.mkdir(getStorageDir(), { recursive: true });
  await fs.writeFile(getTrackerFile(), JSON.stringify(state, null, 2));
}

async function readState() {
  const threshold = await getFailureThreshold();
  const saved = await readJson(getTrackerFile(), emptyState(threshold));

  return {
    threshold,
    accounts: saved && typeof saved.accounts === 'object' && saved.accounts ? saved.accounts : {},
  };
}

async function readCurrentUrlIds() {
  const saved = await readJson(getSourceFile(), null);
  if (!saved) return new Set();

  const sources = Array.isArray(saved.sources) ? saved.sources : (saved.id ? [saved] : []);
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
  const threshold = state.threshold;

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
        persistentFailedAt: consecutiveFailures >= threshold
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

  state.threshold = threshold;
  await writeState(state);
}

export async function getPersistentFailureStatus() {
  const [state, validIds] = await Promise.all([readState(), readCurrentUrlIds()]);
  const threshold = state.threshold;
  const accounts = {};
  let changed = false;

  for (const [id, rawRecord] of Object.entries(state.accounts)) {
    if (!validIds.has(id)) {
      delete state.accounts[id];
      changed = true;
      continue;
    }

    const record = publicRecord(rawRecord);

    if (record.lastStatus === 'failed' && record.consecutiveFailures >= threshold && !record.persistentFailedAt) {
      record.persistentFailedAt = record.lastAutomaticScanAt || new Date().toISOString();
      state.accounts[id] = record;
      changed = true;
    }

    if (record.consecutiveFailures > 0 || record.persistentFailedAt) accounts[id] = record;
  }

  state.threshold = threshold;
  if (changed) await writeState(state);

  const persistentIds = Object.entries(accounts)
    .filter(([, record]) => (
      record.consecutiveFailures >= threshold
      && Boolean(record.persistentFailedAt)
      && record.lastStatus === 'failed'
    ))
    .map(([id]) => id);

  return { threshold, persistentIds, count: persistentIds.length, accounts };
}
