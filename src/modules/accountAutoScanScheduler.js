import fs from 'fs/promises';
import path from 'path';
import { scanAccounts } from './accountHealthService.js';
import { getAppSettings } from './appSettingsService.js';
import { getTenantDataDir, getTenantId, runWithTenantId } from './tenantContext.js';

const BATCH_SIZE = 100;
const STARTUP_CATCHUP_DELAY_MS = 5000;
const schedulers = new Map();

function schedulerState() {
  const tenantId = getTenantId();
  if (!schedulers.has(tenantId)) {
    schedulers.set(tenantId, { timer: null, started: false, running: false });
  }
  return schedulers.get(tenantId);
}

function getStatusFile() {
  return path.join(getTenantDataDir(), 'account-auto-scan.json');
}

function getSourceFile() {
  return path.join(getTenantDataDir(), 'source.json');
}

function defaultStatus() {
  return {
    enabled: true,
    intervalMinutes: 60,
    running: false,
    lastStartedAt: '',
    lastCompletedAt: '',
    nextRunAt: '',
    lastScannedCount: 0,
    lastDeletedCount: 0,
    totalAccounts: 0,
    lastError: '',
  };
}

async function getScanConfig() {
  const settings = await getAppSettings();
  const intervalMinutes = Number(settings.autoScanMinutes) || 0;
  return {
    enabled: intervalMinutes > 0,
    intervalMinutes,
    intervalMs: intervalMinutes * 60 * 1000,
  };
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeStatus(status) {
  await fs.mkdir(getTenantDataDir(), { recursive: true });
  await fs.writeFile(getStatusFile(), JSON.stringify(status, null, 2));
}

async function readStatus() {
  const runtime = schedulerState();
  const [saved, config] = await Promise.all([
    readJson(getStatusFile(), defaultStatus()),
    getScanConfig(),
  ]);

  return {
    ...defaultStatus(),
    ...(saved && typeof saved === 'object' ? saved : {}),
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    running: runtime.running,
  };
}

async function readUrlAccountIds() {
  const saved = await readJson(getSourceFile(), null);
  if (!saved) return [];
  const sources = Array.isArray(saved.sources) ? saved.sources : (saved.id ? [saved] : []);
  return sources
    .filter((source) => source?.id && source.type === 'url')
    .map((source) => String(source.id));
}

function clearTimer() {
  const runtime = schedulerState();
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.timer = null;
}

function scheduleAt(isoTime) {
  const tenantId = getTenantId();
  const runtime = schedulerState();
  clearTimer();

  const target = Date.parse(isoTime);
  const delay = Number.isFinite(target) ? Math.max(0, target - Date.now()) : 0;

  runtime.timer = setTimeout(() => {
    runWithTenantId(tenantId, () => (
      runAutomaticAccountScan().catch((error) => {
        console.error('Automatic account scan failed:', error);
      })
    ));
  }, delay);

  if (typeof runtime.timer.unref === 'function') runtime.timer.unref();
}

async function scheduleNextFrom(status, baseTime = Date.now()) {
  const config = await getScanConfig();

  if (!config.enabled) {
    clearTimer();
    const disabledStatus = {
      ...status,
      enabled: false,
      intervalMinutes: 0,
      running: false,
      nextRunAt: '',
    };
    await writeStatus(disabledStatus);
    return disabledStatus;
  }

  const nextRunAt = new Date(baseTime + config.intervalMs).toISOString();
  const nextStatus = {
    ...status,
    enabled: true,
    intervalMinutes: config.intervalMinutes,
    running: false,
    nextRunAt,
  };

  await writeStatus(nextStatus);
  scheduleAt(nextRunAt);
  return nextStatus;
}

export async function runAutomaticAccountScan() {
  const runtime = schedulerState();
  if (runtime.running) return;

  const config = await getScanConfig();
  if (!config.enabled) {
    await scheduleNextFrom(await readStatus());
    return;
  }

  runtime.running = true;
  clearTimer();

  const startedAtMs = Date.now();
  const ids = await readUrlAccountIds();
  let status = await readStatus();

  status = {
    ...status,
    enabled: true,
    intervalMinutes: config.intervalMinutes,
    running: true,
    lastStartedAt: new Date(startedAtMs).toISOString(),
    nextRunAt: new Date(startedAtMs + config.intervalMs).toISOString(),
    totalAccounts: ids.length,
    lastScannedCount: 0,
    lastDeletedCount: 0,
    lastError: '',
  };
  await writeStatus(status);

  let scannedCount = 0;

  try {
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const batch = ids.slice(offset, offset + BATCH_SIZE);
      const scanResult = await scanAccounts(batch, { automatic: true, scannedAt: status.lastStartedAt });
      scannedCount += batch.length;
      status = { ...status, running: true, lastScannedCount: scannedCount,
        lastDeletedCount: status.lastDeletedCount + (scanResult.deletedIds?.length || 0) };
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
    runtime.running = false;
    await scheduleNextFrom(status, Date.now());
  }
}

export async function reconfigureAccountAutoScanScheduler() {
  clearTimer();
  schedulerState().started = true;
  return scheduleNextFrom(await readStatus(), Date.now());
}

export async function startAccountAutoScanScheduler() {
  const runtime = schedulerState();
  if (runtime.started) return getAccountAutoScanStatus();
  runtime.started = true;

  const config = await getScanConfig();
  let status = await readStatus();

  if (!config.enabled) return scheduleNextFrom(status);

  const savedNext = Date.parse(status.nextRunAt);
  if (!Number.isFinite(savedNext)) return scheduleNextFrom(status, Date.now());

  if (savedNext <= Date.now()) {
    const catchupAt = new Date(Date.now() + STARTUP_CATCHUP_DELAY_MS).toISOString();
    status = {
      ...status,
      enabled: true,
      intervalMinutes: config.intervalMinutes,
      running: false,
      nextRunAt: catchupAt,
    };
    await writeStatus(status);
    scheduleAt(catchupAt);
    return status;
  }

  await writeStatus({ ...status, running: false });
  scheduleAt(status.nextRunAt);
  return status;
}

export async function getAccountAutoScanStatus() {
  const runtime = schedulerState();
  if (!runtime.started) await startAccountAutoScanScheduler();

  const [status, config] = await Promise.all([readStatus(), getScanConfig()]);
  return {
    enabled: config.enabled,
    intervalMinutes: config.intervalMinutes,
    running: runtime.running,
    lastStartedAt: String(status.lastStartedAt || ''),
    lastCompletedAt: String(status.lastCompletedAt || ''),
    nextRunAt: config.enabled ? String(status.nextRunAt || '') : '',
    lastScannedCount: Number(status.lastScannedCount) || 0,
    lastDeletedCount: Number(status.lastDeletedCount) || 0,
    totalAccounts: Number(status.totalAccounts) || 0,
    lastError: String(status.lastError || ''),
  };
}

export function stopAccountAutoScanSchedulerForTenant(tenantId) {
  const id = String(tenantId || '').trim();
  if (!id) return;

  const runtime = schedulers.get(id);
  if (runtime?.timer) clearTimeout(runtime.timer);
  schedulers.delete(id);
}
