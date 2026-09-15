import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { getTenantDataDir } from './tenantContext.js';

function getStorageDir() {
  return getTenantDataDir();
}

function getStorageFile() {
  return path.join(getStorageDir(), 'source.json');
}

async function readSourceFile() {
  try {
    const content = await fs.readFile(getStorageFile(), 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function hashValue(value) {
  return createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function createSourceId(url) {
  return 'src_' + hashValue(url);
}

function createFileSourceId(fileName, channels) {
  const fingerprint = channels.map((channel) => channel.name + '|' + channel.url).join('\n');
  return 'file_' + hashValue(String(fileName || 'dosya') + '\n' + fingerprint);
}

function getDefaultUrlLabel(url, index) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '') || 'Hesap ' + (index + 1);
  } catch {
    return 'Hesap ' + (index + 1);
  }
}

function getDefaultFileLabel(fileName, index) {
  const cleaned = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  return cleaned || 'Dosya ' + (index + 1);
}

function cleanStreamUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

function normalizeStoredChannels(channels) {
  const seen = new Set();
  const normalized = [];

  for (const channel of Array.isArray(channels) ? channels : []) {
    const url = cleanStreamUrl(channel?.url);
    if (!url || seen.has(url)) continue;

    seen.add(url);
    const index = normalized.length;
    normalized.push({
      id: String(index + 1),
      name: String(channel?.name || 'Yayin ' + (index + 1)).trim() || 'Yayin ' + (index + 1),
      logo: String(channel?.logo || '').trim(),
      group: String(channel?.group || 'Genel').trim() || 'Genel',
      tvgId: String(channel?.tvgId || '').trim(),
      url,
      webDurationSeconds: Number.isFinite(Number(channel?.webDurationSeconds))
        ? Number(channel.webDurationSeconds)
        : null,
      webDurationStatus: String(channel?.webDurationStatus || '').trim(),
    });
  }

  return normalized;
}

function normalizeSource(source, index) {
  const type = source?.type === 'file' ? 'file' : 'url';
  const now = new Date().toISOString();

  if (type === 'file') {
    const channels = normalizeStoredChannels(source?.channels);
    if (channels.length === 0) return null;

    const fileName = String(source?.fileName || '').trim();
    return {
      id: String(source?.id || createFileSourceId(fileName, channels)),
      type: 'file',
      label: String(source?.label || getDefaultFileLabel(fileName, index)).trim() || 'Dosya ' + (index + 1),
      url: '',
      fileName,
      channels,
      folder: String(source?.folder || '').trim(),
      sourceKind: String(source?.sourceKind || '').trim(),
      pageUrl: String(source?.pageUrl || '').trim(),
      createdAt: source?.createdAt || source?.updatedAt || now,
      updatedAt: source?.updatedAt || now,
    };
  }

  const url = String(source?.url || '').trim();
  if (!url) return null;

  return {
    id: String(source?.id || createSourceId(url)),
    type: 'url',
    label: String(source?.label || getDefaultUrlLabel(url, index)).trim() || 'Hesap ' + (index + 1),
    url,
    fileName: '',
    channels: [],
    createdAt: source?.createdAt || source?.updatedAt || now,
    updatedAt: source?.updatedAt || now,
  };
}

function normalizeState(saved) {
  if (!saved) return { activeSourceId: '', sources: [] };

  if (Array.isArray(saved.sources)) {
    const sources = saved.sources.map(normalizeSource).filter(Boolean);
    const activeSourceId = sources.some((source) => source.id === saved.activeSourceId)
      ? saved.activeSourceId
      : sources[0]?.id || '';

    return { activeSourceId, sources };
  }

  const legacy = normalizeSource({ ...saved, type: 'url' }, 0);
  return {
    activeSourceId: legacy?.id || '',
    sources: legacy ? [legacy] : [],
  };
}

async function readState() {
  return normalizeState(await readSourceFile());
}

async function writeState(state) {
  await fs.mkdir(getStorageDir(), { recursive: true });

  if (state.sources.length === 0) {
    try {
      await fs.unlink(getStorageFile());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return;
  }

  await fs.writeFile(getStorageFile(), JSON.stringify(state, null, 2));
}

function cleanUrl(value) {
  const url = String(value || '').trim();

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Gecerli bir http veya https yayin URL girin.');
  }

  return url;
}

function publicSource(source, activeSourceId) {
  const isFile = source.type === 'file';

  return {
    id: source.id,
    type: source.type,
    label: source.label,
    url: isFile ? '' : maskUrl(source.url),
    fileName: source.fileName || '',
    channelCount: isFile ? source.channels.length : 0,
    folder: source.folder || '',
    sourceKind: source.sourceKind || '',
    pageUrl: source.pageUrl || '',
    active: source.id === activeSourceId,
    updatedAt: source.updatedAt,
  };
}

export async function getActivePlaylistSource() {
  const state = await readState();
  const active = state.sources.find((source) => source.id === state.activeSourceId) || state.sources[0];

  if (!active) return null;
  return {
    ...active,
    channels: active.channels || [],
  };
}

export async function getPlaylistSource() {
  const active = await getActivePlaylistSource();
  return active?.type === 'url' ? active.url : '';
}

export async function getSourceStatus() {
  const state = await readState();
  const active = state.sources.find((source) => source.id === state.activeSourceId) || state.sources[0];

  return {
    hasSource: state.sources.length > 0,
    url: active && active.type === 'url' ? maskUrl(active.url) : '',
    activeSourceId: active?.id || '',
    sources: state.sources.map((source) => publicSource(source, active?.id || '')),
  };
}

export async function savePlaylistSource(url, label = '') {
  const clean = cleanUrl(url);
  const state = await readState();
  const now = new Date().toISOString();
  const id = createSourceId(clean);
  const existing = state.sources.find((source) => source.id === id);

  if (existing) {
    existing.type = 'url';
    existing.label = String(label || existing.label || getDefaultUrlLabel(clean, state.sources.length)).trim();
    existing.url = clean;
    existing.fileName = '';
    existing.channels = [];
    existing.updatedAt = now;
  } else {
    state.sources.push({
      id,
      type: 'url',
      label: String(label || getDefaultUrlLabel(clean, state.sources.length)).trim(),
      url: clean,
      fileName: '',
      channels: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  state.activeSourceId = id;
  await writeState(state);
  return getSourceStatus();
}

export async function savePlaylistSources(sources = []) {
  const state = await readState();
  const now = new Date().toISOString();
  const imported = [];
  const seen = new Set();

  for (const entry of Array.isArray(sources) ? sources : []) {
    const clean = cleanUrl(entry?.url);
    if (seen.has(clean)) continue;
    seen.add(clean);

    const id = createSourceId(clean);
    const existing = state.sources.find((source) => source.id === id);
    const label = String(entry?.label || getDefaultUrlLabel(clean, state.sources.length)).trim();

    if (existing) {
      existing.type = 'url';
      existing.label = label || existing.label;
      existing.url = clean;
      existing.fileName = '';
      existing.channels = [];
      existing.updatedAt = now;
    } else {
      state.sources.push({
        id,
        type: 'url',
        label: label || getDefaultUrlLabel(clean, state.sources.length),
        url: clean,
        fileName: '',
        channels: [],
        createdAt: now,
        updatedAt: now,
      });
    }

    imported.push(id);
  }

  if (imported.length === 0) {
    throw new Error('Dosyada kaydedilecek yayin hesabi bulunamadi.');
  }

  state.activeSourceId = imported[0];
  await writeState(state);
  return getSourceStatus();
}

export async function saveUploadedPlaylistSource({ label = '', fileName = '', channels = [] } = {}) {
  const normalizedChannels = normalizeStoredChannels(channels);

  if (normalizedChannels.length === 0) {
    throw new Error('Dosyada kaydedilecek yayin bulunamadi.');
  }

  const state = await readState();
  const now = new Date().toISOString();
  const id = createFileSourceId(fileName, normalizedChannels);
  const existing = state.sources.find((source) => source.id === id);
  const sourceLabel = String(label || getDefaultFileLabel(fileName, state.sources.length)).trim();

  if (existing) {
    existing.type = 'file';
    existing.label = sourceLabel || existing.label;
    existing.url = '';
    existing.fileName = String(fileName || existing.fileName || '').trim();
    existing.channels = normalizedChannels;
    existing.updatedAt = now;
  } else {
    state.sources.push({
      id,
      type: 'file',
      label: sourceLabel || 'Dosya ' + (state.sources.length + 1),
      url: '',
      fileName: String(fileName || '').trim(),
      channels: normalizedChannels,
      createdAt: now,
      updatedAt: now,
    });
  }

  state.activeSourceId = id;
  await writeState(state);
  return getSourceStatus();
}

export async function saveWebScanPlaylistSource({ label = '', pageUrl = '', channels = [] } = {}) {
  const normalizedChannels = normalizeStoredChannels(channels);

  if (normalizedChannels.length === 0) {
    throw new Error('Web taramasinda kaydedilecek yayin bulunamadi.');
  }

  const state = await readState();
  const now = new Date().toISOString();
  const fingerprint = normalizedChannels.map((channel) => channel.url).join('\n');
  const id = 'webscan_' + hashValue(String(pageUrl || '') + '\n' + fingerprint);
  const existing = state.sources.find((source) => source.id === id);
  const sourceLabel = String(label || 'Web Tarama').trim() || 'Web Tarama';

  if (existing) {
    existing.type = 'file';
    existing.label = sourceLabel;
    existing.url = '';
    existing.fileName = 'web-tarama.m3u';
    existing.channels = normalizedChannels;
    existing.folder = 'Web Tarama';
    existing.sourceKind = 'web-scan';
    existing.pageUrl = String(pageUrl || '').trim();
    existing.updatedAt = now;
  } else {
    state.sources.push({
      id,
      type: 'file',
      label: sourceLabel,
      url: '',
      fileName: 'web-tarama.m3u',
      channels: normalizedChannels,
      folder: 'Web Tarama',
      sourceKind: 'web-scan',
      pageUrl: String(pageUrl || '').trim(),
      createdAt: now,
      updatedAt: now,
    });
  }

  state.activeSourceId = id;
  await writeState(state);
  return getSourceStatus();
}

export async function setActivePlaylistSource(sourceId) {
  const state = await readState();
  const source = state.sources.find((item) => item.id === String(sourceId));

  if (!source) {
    throw new Error('Yayin hesabi bulunamadi.');
  }

  state.activeSourceId = source.id;
  await writeState(state);
  return getSourceStatus();
}

export async function deletePlaylistSource(sourceId = '') {
  const state = await readState();
  const id = String(sourceId || '').trim();

  if (id) {
    state.sources = state.sources.filter((source) => source.id !== id);
    if (state.activeSourceId === id) state.activeSourceId = state.sources[0]?.id || '';
  } else {
    state.sources = [];
    state.activeSourceId = '';
  }

  await writeState(state);
  return getSourceStatus();
}

function maskUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('username')) parsed.searchParams.set('username', '***');
    if (parsed.searchParams.has('password')) parsed.searchParams.set('password', '***');
    return parsed.toString();
  } catch {
    return 'Kayitli yayin var';
  }
}
