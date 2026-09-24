import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getTenantDataDir, runWithTenantId } from '../src/modules/tenantContext.js';
import {
  addAccountFavorite,
  clearAccountFavorites,
  listAccountFavorites,
  removeAccountFavorite,
  removeAccountFavorites,
} from '../src/modules/accountFavoritesService.js';

async function withTenant(callback) {
  const tenant = 'account-favorites-test-' + randomUUID();
  await runWithTenantId(tenant, async () => {
    const dir = getTenantDataDir();
    try {
      await callback();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

test('account favorites add, remove and prune missing accounts', async () => {
  await withTenant(async () => {
    assert.deepEqual(await listAccountFavorites(['a', 'b']), { ids: [] });
    assert.deepEqual(await addAccountFavorite('a', ['a', 'b']), { ids: ['a'] });
    assert.deepEqual(await addAccountFavorite('b', ['a', 'b']), { ids: ['a', 'b'] });
    assert.deepEqual(await addAccountFavorite('a', ['a', 'b']), { ids: ['a', 'b'] });
    assert.deepEqual(await listAccountFavorites(['b']), { ids: ['b'] });
    assert.deepEqual(await removeAccountFavorite('b'), { ids: [] });
  });
});

test('bulk removal and clear are deterministic', async () => {
  await withTenant(async () => {
    await addAccountFavorite('a', ['a', 'b', 'c']);
    await addAccountFavorite('b', ['a', 'b', 'c']);
    await addAccountFavorite('c', ['a', 'b', 'c']);
    assert.deepEqual(await removeAccountFavorites(['a', 'c', 'a']), { ids: ['b'] });
    assert.deepEqual(await clearAccountFavorites(), { ids: [] });
  });
});

test('account favorites are isolated per tenant', async () => {
  const first = 'account-favorites-a-' + randomUUID();
  const second = 'account-favorites-b-' + randomUUID();
  let firstDir;
  let secondDir;
  try {
    await runWithTenantId(first, async () => {
      firstDir = getTenantDataDir();
      await addAccountFavorite('same', ['same']);
    });
    await runWithTenantId(second, async () => {
      secondDir = getTenantDataDir();
      assert.deepEqual(await listAccountFavorites(['same']), { ids: [] });
      await addAccountFavorite('same', ['same']);
    });
    await runWithTenantId(first, async () => {
      assert.deepEqual(await listAccountFavorites(['same']), { ids: ['same'] });
    });
  } finally {
    if (firstDir) await fs.rm(firstDir, { recursive: true, force: true });
    if (secondDir) await fs.rm(secondDir, { recursive: true, force: true });
  }
});

test('unknown account cannot be favorited', async () => {
  await withTenant(async () => {
    await assert.rejects(
      Promise.resolve().then(() => addAccountFavorite('missing', ['a'])),
      /Hesap bulunamadi/
    );
  });
});


test('accounts beyond the first 5000 can be favorited', async () => {
  await withTenant(async () => {
    const ids = Array.from({ length: 5005 }, (_, index) => 'account-' + index);
    const result = await addAccountFavorite('account-5004', ids);
    assert.deepEqual(result, { ids: ['account-5004'] });
    assert.deepEqual(await listAccountFavorites(ids), { ids: ['account-5004'] });
  });
});
