import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const storageDir = path.join(process.cwd(), 'data');
const storageFile = path.join(storageDir, 'source.json');

async function readSourceFile() {
  try {
    const content = await fs.readFile(storageFile, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function createSourceId(url) {
  return `src_${createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

function getDefaultLabel(url, index) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, '') || `Hesap ${index + 1}`;
  } catch {
    return `Hesap ${index + 1}`;
  }
}

function normalizeSource(source, index) {
  const url = String(source?.url || '').trim();
  if (!url) return null;

  const now = new Date().toISOString();
  return {
    id: String(source.id || createSourceId(url)),
    label: String(source.label || getDefaultLabel(url, index)).trim() || `Hesap ${index + 1}`,
    url,
    createdAt: source.createdAt || source.updatedAt || now,
    updatedAt: source.updatedAt || now,
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

  const legacy = normalizeSource(saved, 0);
  return {
    activeSourceId: legacy?.id || '',
    sources: legacy ? [legacy] : [],
  };
}

async function readState() {
  return normalizeState(await readSourceFile());
}

async function writeState(state) {
  await fs.mkdir(storageDir, { recursive: true });

  if (state.sources.length === 0) {
    try {
      await fs.unlink(storageFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return;
  }

  await fs.writeFile(storageFile, JSON.stringify(state, null, 2));
}

function cleanUrl(value) {
  const url = String(value || '').trim();

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Gecerli bir http veya https yayin URL girin.');
  }

  return url;
}

function publicSource(source, activeSourceId) {
  return {
    id: source.id,
    label: source.label,
    url: maskUrl(source.url),
    active: source.id === activeSourceId,
    updatedAt: source.updatedAt,
  };
}

export async function getPlaylistSource() {
  const state = await readState();
  const active = state.sources.find((source) => source.id === state.activeSourceId) || state.sources[0];
  return active?.url || '';
}

export async function getSourceStatus() {
  const state = await readState();
  const active = state.sources.find((source) => source.id === state.activeSourceId) || state.sources[0];

  return {
    hasSource: state.sources.length > 0,
    url: active ? maskUrl(active.url) : '',
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
    existing.label = String(label || existing.label || getDefaultLabel(clean, state.sources.length)).trim();
    existing.url = clean;
    existing.updatedAt = now;
  } else {
    state.sources.push({
      id,
      label: String(label || getDefaultLabel(clean, state.sources.length)).trim(),
      url: clean,
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
