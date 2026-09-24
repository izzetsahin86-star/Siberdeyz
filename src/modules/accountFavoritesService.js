import fs from 'fs/promises';
import path from 'path';
import { getTenantDataDir } from './tenantContext.js';
import { withTenantMutation } from './tenantMutationQueue.js';

const FILE_NAME = 'account-favorites.json';
const MAX_FAVORITES = 5000;

function getFilePath() {
  return path.join(getTenantDataDir(), FILE_NAME);
}

function normalizeIds(values = [], { limit = true } = {}) {
  const ids = Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
  return limit ? ids.slice(0, MAX_FAVORITES) : ids;
}

async function readState() {
  try {
    const raw = await fs.readFile(getFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ids: normalizeIds(parsed?.ids) };
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return { ids: [] };
    throw error;
  }
}

async function writeState(state) {
  const file = getFilePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify({ ids: normalizeIds(state.ids) }, null, 2));
  await fs.rename(file + '.tmp', file);
}

function sourceId(value) {
  return String(value || '').trim();
}

export function listAccountFavorites(validSourceIds = null) {
  return withTenantMutation('account-favorites', async () => {
    const state = await readState();

    if (Array.isArray(validSourceIds)) {
      const valid = new Set(normalizeIds(validSourceIds, { limit: false }));
      const filtered = state.ids.filter((id) => valid.has(id));
      if (filtered.length !== state.ids.length) {
        state.ids = filtered;
        await writeState(state);
      }
    }

    return { ids: [...state.ids] };
  });
}

export function addAccountFavorite(value, validSourceIds = []) {
  const id = sourceId(value);
  const valid = new Set(normalizeIds(validSourceIds, { limit: false }));

  if (!id || !valid.has(id)) {
    const error = new Error('Hesap bulunamadi.');
    error.status = 404;
    throw error;
  }

  return withTenantMutation('account-favorites', async () => {
    const state = await readState();
    if (!state.ids.includes(id)) {
      state.ids.push(id);
      await writeState(state);
    }
    return { ids: [...state.ids] };
  });
}

export function removeAccountFavorite(value) {
  const id = sourceId(value);

  return withTenantMutation('account-favorites', async () => {
    const state = await readState();
    const next = state.ids.filter((item) => item !== id);
    if (next.length !== state.ids.length) {
      state.ids = next;
      await writeState(state);
    }
    return { ids: [...state.ids] };
  });
}

export function removeAccountFavorites(values = []) {
  const remove = new Set(normalizeIds(values));

  return withTenantMutation('account-favorites', async () => {
    const state = await readState();
    if (remove.size === 0) return { ids: [...state.ids] };

    const next = state.ids.filter((id) => !remove.has(id));
    if (next.length !== state.ids.length) {
      state.ids = next;
      await writeState(state);
    }
    return { ids: [...state.ids] };
  });
}

export function clearAccountFavorites() {
  return withTenantMutation('account-favorites', async () => {
    await writeState({ ids: [] });
    return { ids: [] };
  });
}
