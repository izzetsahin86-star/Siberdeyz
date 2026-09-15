import fs from 'fs/promises';
import path from 'path';
import { getTenantDataDir } from './tenantContext.js';

function getStorageDir() {
  return getTenantDataDir();
}

function getSettingsFile() {
  return path.join(getStorageDir(), 'app-settings.json');
}

const DEFAULT_SETTINGS = Object.freeze({
  startupSound: false,
  autoScanMinutes: 60,
  failureThreshold: 3,
  playbackMode: 'auto',
  autoRetry: true,
  retryCount: 3,
  defaultPanel: 'channels',
  channelDensity: 'compact',
});

const ALLOWED_SCAN_MINUTES = new Set([0, 30, 60, 120]);
const ALLOWED_FAILURE_THRESHOLDS = new Set([2, 3, 5]);
const ALLOWED_PLAYBACK_MODES = new Set(['auto', 'direct', 'compatibility']);
const ALLOWED_RETRY_COUNTS = new Set([1, 3, 5]);
const ALLOWED_DEFAULT_PANELS = new Set(['channels', 'accounts']);
const ALLOWED_CHANNEL_DENSITIES = new Set(['normal', 'compact']);

function sanitizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function sanitizeNumber(value, allowed, fallback) {
  const number = Number(value);
  return allowed.has(number) ? number : fallback;
}

function sanitizeString(value, allowed, fallback) {
  const text = String(value || '');
  return allowed.has(text) ? text : fallback;
}

function sanitizeSettings(input = {}) {
  return {
    startupSound: sanitizeBoolean(input.startupSound, DEFAULT_SETTINGS.startupSound),
    autoScanMinutes: sanitizeNumber(input.autoScanMinutes, ALLOWED_SCAN_MINUTES, DEFAULT_SETTINGS.autoScanMinutes),
    failureThreshold: sanitizeNumber(input.failureThreshold, ALLOWED_FAILURE_THRESHOLDS, DEFAULT_SETTINGS.failureThreshold),
    playbackMode: sanitizeString(input.playbackMode, ALLOWED_PLAYBACK_MODES, DEFAULT_SETTINGS.playbackMode),
    autoRetry: sanitizeBoolean(input.autoRetry, DEFAULT_SETTINGS.autoRetry),
    retryCount: sanitizeNumber(input.retryCount, ALLOWED_RETRY_COUNTS, DEFAULT_SETTINGS.retryCount),
    defaultPanel: sanitizeString(input.defaultPanel, ALLOWED_DEFAULT_PANELS, DEFAULT_SETTINGS.defaultPanel),
    channelDensity: sanitizeString(input.channelDensity, ALLOWED_CHANNEL_DENSITIES, DEFAULT_SETTINGS.channelDensity),
  };
}

async function readSavedSettings() {
  try {
    const content = await fs.readFile(getSettingsFile(), 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export async function getAppSettings() {
  const saved = await readSavedSettings();
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) });
}

export async function updateAppSettings(patch = {}) {
  const current = await getAppSettings();
  const next = sanitizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });

  await fs.mkdir(getStorageDir(), { recursive: true });
  const settingsFile = getSettingsFile();
  const tempFile = settingsFile + '.tmp';
  await fs.writeFile(tempFile, JSON.stringify(next, null, 2));
  await fs.rename(tempFile, settingsFile);

  return next;
}

export function getDefaultAppSettings() {
  return { ...DEFAULT_SETTINGS };
}
