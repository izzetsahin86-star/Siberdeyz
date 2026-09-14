import fs from 'fs/promises';
import path from 'path';

const storageDir = path.join(process.cwd(), 'data');
const favoritesFile = path.join(storageDir, 'favorites.json');

async function readFavorites() {
  try {
    const content = await fs.readFile(favoritesFile, 'utf-8');
    const parsed = JSON.parse(content);
    return Array.isArray(parsed.ids) ? parsed.ids.map(String) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeFavorites(ids) {
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(favoritesFile, JSON.stringify({ ids: [...new Set(ids.map(String))] }, null, 2));
}

export async function listFavorites() {
  return { ids: await readFavorites() };
}

export async function addFavorite(channelId) {
  const ids = await readFavorites();
  ids.push(String(channelId));
  await writeFavorites(ids);
  return listFavorites();
}

export async function removeFavorite(channelId) {
  const ids = await readFavorites();
  await writeFavorites(ids.filter((id) => id !== String(channelId)));
  return listFavorites();
}

export async function clearFavorites() {
  await writeFavorites([]);
  return listFavorites();
}
