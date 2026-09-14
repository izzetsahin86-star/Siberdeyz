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

export async function getPlaylistSource() {
  const saved = await readSourceFile();
  return saved?.url || '';
}

export async function getSourceStatus() {
  const url = await getPlaylistSource();
  return {
    hasSource: Boolean(url),
    url: url ? maskUrl(url) : '',
  };
}

export async function savePlaylistSource(url) {
  const cleanUrl = String(url || '').trim();

  if (!/^https?:\/\//i.test(cleanUrl)) {
    throw new Error('Gecerli bir http veya https yayin URL girin.');
  }

  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(storageFile, JSON.stringify({ url: cleanUrl, updatedAt: new Date().toISOString() }, null, 2));
  return getSourceStatus();
}

export async function deletePlaylistSource() {
  try {
    await fs.unlink(storageFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

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
