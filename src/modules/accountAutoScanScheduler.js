import fs from 'fs/promises';
import path from 'path';
import { scanAccounts } from './accountHealthService.js';

const storageDir = path.join(process.cwd(), 'data');
const sourceFile = path.join(storageDir, 'source.json');
const statusFile = path.join(storageDir, 'account-auto-scan.json');
const INTERVAL_MS = 60 * 60 * 1000;
const BATCH_SIZE = 100;
const STARTUP_CATCHUP_DELAY_MS = 5000;

let timer = null;
let started = false;
let running = false;

function defaultStatus() {
  return {
    enabled: true,
    intervalMinutes: 60,
    running: false,
    lastStartedAt: '',
    lastCompletedAt: '',
    nextRunAt: '',
    lastScannedCount: 0,
    totalAccounts: 0,
    lastError: '',
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

async function writeStatus(status) {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(statusFile, JSON.stringify(status, null, 2));
}

async function readStatus() {
  const saved = await readJson(statusFile, defaultStatus());
  return {
    ...defaultStatus(),
    ...(saved && typeof saved === 'object' ? saved : {}),
    enabled: true,
    intervalMinutes: 60,
    running,
  };
}

async function readUrlAccountIds() {
  const saved = await readJson(sourceFile, null);
  if (!saved) return [];

  const sources = Array.isArray(saved.sources)
    ? saved.sources
    : (saved.id ? [saved] : []);

  return sources
    .filter((source) => source?.id && source.type === 'url')
    .map((source) => String(source.id));
}

function clearTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function scheduleAt(isoTime) {
  clearTimer();

  const target = Date.parse(isoTime);
  const delay = Number.isFinite(target)
    ? Math.max(0, target - Date.now())
    : INTERVAL_MS;

  timer = setTimeout(() => {
    runAutomaticAccountScan().catch((error) => {
      console.error('Automatic account scan failed:', error);
    });
  }, delay);

  if (typeof timer.unref === 'function') timer.unref();
}

async function scheduleNextFrom(status, baseTime = Date.now()) {
  const nextRunAt = new Date(baseTime + INTERVAL_MS).toISOString();
  const nextStatus = {
    ...status,
    running: false,
    nextRunAt,
  };

  await writeStatus(nextStatus);
  scheduleAt(nextRunAt);
  return nextStatus;
}

async function runAutomaticAccountScan() {
  if (running) return;

  running = true;
  clearTimer();

  const startedAtMs = Date.now();
  const ids = await readUrlAccountIds();
  let status = await readStatus();

  status = {
    ...status,
    running: true,
    lastStartedAt: new Date(startedAtMs).toISOString(),
    nextRunAt: new Date(startedAtMs + INTERVAL_MS).toISOString(),
    totalAccounts: ids.length,
    lastScannedCount: 0,
    lastError: '',
  };
  await writeStatus(status);

  let scannedCount = 0;

  try {
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const batch = ids.slice(offset, offset + BATCH_SIZE);
      await scanAccounts(batch);
      scannedCount += batch.length;

      status = {
        ...status,
        running: true,
        lastScannedCount: scannedCount,
      };
      await writeStatus(status);
    }

    status = {
      ...status,
      running: false,
      lastCompletedAt: new Date().toISOString(),
      lastScannedCount: scannedCount,
      lastError: '',
    };
  } catch (error) {
    status = {
      ...status,
      running: false,
      lastCompletedAt: new Date().toISOString(),
      lastScannedCount: scannedCount,
      lastError: String(error?.message || 'Otomatik tarama tamamlanamadi.'),
    };
  } finally {
    running = false;

    const plannedNext = Date.parse(status.nextRunAt);
    const nextBase = Number.isFinite(plannedNext) && plannedNext > Date.now()
      ? plannedNext - INTERVAL_MS
      : Date.now();

    await scheduleNextFrom(status, nextBase);
  }
}

export async function startAccountAutoScanScheduler() {
  if (started) return getAccountAutoScanStatus();
  started = true;

  let status = await readStatus();
  const savedNext = Date.parse(status.nextRunAt);

  if (!Number.isFinite(savedNext)) {
    status = await scheduleNextFrom(status, Date.now());
    return status;
  }

  if (savedNext <= Date.now()) {
    const catchupAt = new Date(Date.now() + STARTUP_CATCHUP_DELAY_MS).toISOString();
    status = {
      ...status,
      running: false,
      nextRunAt: catchupAt,
    };
    await writeStatus(status);
    scheduleAt(catchupAt);
    return status;
  }

  status = {
    ...status,
    running: false,
  };
  await writeStatus(status);
  scheduleAt(status.nextRunAt);
  return status;
}

export async function getAccountAutoScanStatus() {
  const status = await readStatus();

  return {
    enabled: true,
    intervalMinutes: 60,
    running,
    lastStartedAt: String(status.lastStartedAt || ''),
    lastCompletedAt: String(status.lastCompletedAt || ''),
    nextRunAt: String(status.nextRunAt || ''),
    lastScannedCount: Number(status.lastScannedCount) || 0,
    totalAccounts: Number(status.totalAccounts) || 0,
    lastError: String(status.lastError || ''),
  };
}
