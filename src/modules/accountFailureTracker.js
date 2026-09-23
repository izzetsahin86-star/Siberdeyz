import { withTenantMutation } from './tenantMutationQueue.js';
import fs from 'fs/promises';
import path from 'path';
import { getAppSettings } from './appSettingsService.js';
import { getTenantDataDir } from './tenantContext.js';

export const AUTOMATIC_DELETE_THRESHOLD = 50;

function getStorageDir() {
  return getTenantDataDir();
}

function getSourceFile() {
  return path.join(getStorageDir(), 'source.json');
}

function getTrackerFile() {
  return path.join(getStorageDir(), 'account-failure-tracker.json');
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
  const file = getTrackerFile();
  await fs.writeFile(file + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(file + '.tmp', file);
}

async function readState() {
  const settings = await getAppSettings();
  const threshold = Number(settings.failureThreshold) || 3;
  const saved = await readJson(getTrackerFile(), emptyState(threshold));

  return {
    threshold,
    automaticDeleteDays: settings.automaticDeleteDays || 0,
    automaticDeleteScans: settings.automaticDeleteScans || AUTOMATIC_DELETE_THRESHOLD,
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
    sourceUpdatedAt: String(record.sourceUpdatedAt || ''),
    firstAutomaticFailureAt: String(record.firstAutomaticFailureAt || ''),
    lastStatus: String(record.lastStatus || ''),
    lastAutomaticScanAt: String(record.lastAutomaticScanAt || ''),
    persistentFailedAt: String(record.persistentFailedAt || ''),
  };
}

export function recordAccountScanResults(results = [], { automatic = false, scannedAt = new Date().toISOString() } = {}) {
  return withTenantMutation('failures', async () => {
    const state = await readState();
    const validIds = await readCurrentUrlIds();
    const candidates = [];
    const seen = new Set();
    for (const result of Array.isArray(results) ? results : []) {
      const id = String(result?.id || '').trim();
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      const status = String(result?.health?.status || '');
      const saved = publicRecord(state.accounts[id]);
      const sourceUpdatedAt = String(result.sourceUpdatedAt || saved.sourceUpdatedAt);
      const previous = saved.sourceUpdatedAt && saved.sourceUpdatedAt !== sourceUpdatedAt
        ? publicRecord() : saved;
      if (status === 'active') {
        state.accounts[id] = { ...previous, sourceUpdatedAt, consecutiveFailures: 0,
          lastStatus: status, persistentFailedAt: '', firstAutomaticFailureAt: '',
          lastAutomaticScanAt: automatic ? scannedAt : previous.lastAutomaticScanAt };
      } else if (status === 'expired') {
        state.accounts[id] = { ...previous, sourceUpdatedAt, consecutiveFailures: 0,
          lastStatus: status, persistentFailedAt: '', firstAutomaticFailureAt: '',
          lastAutomaticScanAt: automatic ? scannedAt : previous.lastAutomaticScanAt };
        // Expiration comes from the provider account API/expiry date. Only the
        // scheduled scanner may turn that result into permanent deletion.
        if (automatic) candidates.push(id);
      } else if (automatic && status === 'failed') {
        // Retrying the same scheduled batch must never count it twice.
        const failures = previous.consecutiveFailures + (previous.lastAutomaticScanAt === scannedAt ? 0 : 1);
        const firstAutomaticFailureAt = previous.consecutiveFailures > 0
          ? (previous.firstAutomaticFailureAt || previous.persistentFailedAt || scannedAt) : scannedAt;
        state.accounts[id] = { sourceUpdatedAt, firstAutomaticFailureAt, consecutiveFailures: failures, lastStatus: status,
          lastAutomaticScanAt: scannedAt,
          persistentFailedAt: failures >= state.threshold ? (previous.persistentFailedAt || scannedAt) : '' };
        const elapsed = Date.parse(scannedAt) - Date.parse(firstAutomaticFailureAt);
        const shouldDelete = state.automaticDeleteDays > 0
          ? failures >= state.threshold && Number.isFinite(elapsed) && elapsed >= state.automaticDeleteDays * 86400000
          : failures >= state.automaticDeleteScans;
        if (shouldDelete) candidates.push(id);
      }
    }
    await writeState(state);
    return candidates;
  });
}

export function recordAutomaticScanResults(results = [], scannedAt = new Date().toISOString()) {
  return recordAccountScanResults(results, { automatic: true, scannedAt });
}

export function removeAccountFailureRecords(ids = []) {
  return withTenantMutation('failures', async () => {
    const state = await readState();
    for (const id of ids) delete state.accounts[id];
    await writeState(state);
  });
}

async function getPersistentFailureStatusUnlocked() {
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

  return { threshold, automaticDeleteDays: state.automaticDeleteDays, automaticDeleteThreshold: state.automaticDeleteScans, persistentIds, count: persistentIds.length, accounts };
}

export function getPersistentFailureStatus() {
  return withTenantMutation('failures', getPersistentFailureStatusUnlocked);
}
