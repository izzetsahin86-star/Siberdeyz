import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWithTenantId, getTenantDataDir } from '../src/modules/tenantContext.js';
import { savePlaylistSource, getSourceStatus, getPlaylistSourceById, saveUploadedPlaylistSource } from '../src/modules/sourceStorage.js';
import { scanAccounts, scanAccount, getAccountHealth } from '../src/modules/accountHealthService.js';
import { getPersistentFailureStatus, recordAutomaticScanResults } from '../src/modules/accountFailureTracker.js';
import { runAutomaticAccountScan, stopAccountAutoScanSchedulerForTenant, getAccountAutoScanStatus } from '../src/modules/accountAutoScanScheduler.js';
import { updateAppSettings } from '../src/modules/appSettingsService.js';

async function fixture(callback) {
  const tenant = 'cleanup-test-' + randomUUID();
  await runWithTenantId(tenant, async () => {
    const dir = getTenantDataDir();
    const originalFetch = globalThis.fetch;
    // No network and no existing account data: every test owns a fresh tenant.
    globalThis.fetch = async () => new Response('', { status: 503 });
    try {
      const source = await savePlaylistSource('https://test.invalid/list.m3u', 'Test account');
      await callback({ id: source.activeSourceId, dir, tenant });
    } finally {
      globalThis.fetch = originalFetch;
      stopAccountAutoScanSchedulerForTenant(tenant);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
const automatic = index => ({ automatic: true, scannedAt: new Date(1800000000000 + index * 60000).toISOString() });
async function seedFailures(dir, id, count) {
  await fs.writeFile(path.join(dir, 'account-failure-tracker.json'), JSON.stringify({ accounts: {
    [id]: { consecutiveFailures: count, lastStatus: 'failed', persistentFailedAt: '2026-01-01T00:00:00.000Z', lastAutomaticScanAt: '2026-01-01T00:00:00.000Z' },
  } }));
}

test('49 automatic failures preserve source; 50th deletes source, health and tracker, including active selection', async () => {
  await fixture(async ({ id }) => {
    for (let i = 1; i <= 49; i++) await scanAccounts([id], automatic(i));
    assert.ok(await getPlaylistSourceById(id));
    let failures = await getPersistentFailureStatus();
    assert.equal(failures.accounts[id].consecutiveFailures, 49);
    assert.deepEqual(failures.persistentIds, [id]);
    assert.equal(failures.automaticDeleteThreshold, 50);
    const result = await scanAccounts([id], automatic(50));
    assert.deepEqual(result.deletedIds, [id]);
    assert.equal(await getPlaylistSourceById(id), null);
    assert.equal((await getSourceStatus()).activeSourceId, '');
    assert.equal((await getAccountHealth()).accounts[id], undefined);
    assert.equal((await getPersistentFailureStatus()).accounts[id], undefined);
  });
});

test('active automatic result at scan 49 removes persistent label and restarts failures at one', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 48);
    globalThis.fetch = async () => new Response('#EXTM3U\n', { status: 200 });
    await scanAccounts([id], automatic(49));
    assert.equal((await getAccountHealth()).accounts[id].status, 'active');
    assert.deepEqual((await getPersistentFailureStatus()).persistentIds, []);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await scanAccounts([id], automatic(50));
    assert.ok(await getPlaylistSourceById(id));
    assert.equal((await getPersistentFailureStatus()).accounts[id].consecutiveFailures, 1);
  });
});

test('manual failures never increment or delete; manual recovery also clears the label', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 49);
    await scanAccount(id);
    await scanAccounts([id]);
    assert.equal((await getPersistentFailureStatus()).accounts[id].consecutiveFailures, 49);
    globalThis.fetch = async () => new Response('#EXTM3U\n', { status: 200 });
    await scanAccount(id);
    assert.deepEqual((await getPersistentFailureStatus()).persistentIds, []);
    assert.ok(await getPlaylistSourceById(id));
  });
});

test('same automatic batch is idempotent and files/unknown IDs are excluded', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 48);
    const uploaded = await saveUploadedPlaylistSource({ fileName: 'test.m3u', channels: [{ name: 'Test', url: 'https://test.invalid/stream.ts' }] });
    const fileId = uploaded.activeSourceId;
    await scanAccounts([id, id, fileId, 'missing'], automatic(49));
    await scanAccounts([id], automatic(49));
    await recordAutomaticScanResults([{ id: fileId, health: { status: 'failed' } }], automatic(50).scannedAt);
    const failures = await getPersistentFailureStatus();
    assert.equal(failures.accounts[id].consecutiveFailures, 49);
    assert.equal(failures.accounts[fileId], undefined);
    assert.ok(await getPlaylistSourceById(fileId));
  });
});

test('real scheduler deletes at threshold, reports deletions, and respects disabled scheduling', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 49);
    await updateAppSettings({ autoScanMinutes: 0 });
    await runAutomaticAccountScan();
    assert.ok(await getPlaylistSourceById(id));
    await updateAppSettings({ autoScanMinutes: 60 });
    await runAutomaticAccountScan();
    assert.equal(await getPlaylistSourceById(id), null);
    const status = await getAccountAutoScanStatus();
    assert.equal(status.lastDeletedCount, 1);
    assert.equal(status.lastScannedCount, 1);
    assert.equal(status.lastError, '');
  });
});

test('editing a source during its scan prevents stale failure results from deleting it', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 49);
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async () => { started(); await new Promise(resolve => { release = resolve; }); return new Response('', { status: 503 }); };
    const pending = scanAccounts([id], automatic(50));
    await ready;
    await savePlaylistSource('https://test.invalid/list.m3u', 'Edited account');
    release();
    await pending;
    assert.equal((await getPlaylistSourceById(id)).label, 'Edited account');
  });
});

test('concurrent saves retain every source under the mutation queue', async () => {
  await fixture(async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => savePlaylistSource('https://test.invalid/' + i + '.m3u')));
    assert.equal((await getSourceStatus()).sources.length, 13);
  });
});

test('an active 50th check also saves the account instead of deleting it', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 49);
    globalThis.fetch = async () => new Response('#EXTM3U\n', { status: 200 });
    const result = await scanAccounts([id], automatic(50));
    assert.deepEqual(result.deletedIds, []);
    assert.ok(await getPlaylistSourceById(id));
    assert.deepEqual((await getPersistentFailureStatus()).persistentIds, []);
  });
});

test('cleanup remains tenant-scoped even when another user has the same source ID', async () => {
  await fixture(async ({ id, dir }) => {
    await seedFailures(dir, id, 49);
    const otherTenant = 'cleanup-other-' + randomUUID();
    let otherDir;
    try {
      await runWithTenantId(otherTenant, async () => {
        otherDir = getTenantDataDir();
        const other = await savePlaylistSource('https://test.invalid/list.m3u', 'Other user');
        assert.equal(other.activeSourceId, id);
      });
      await scanAccounts([id], automatic(50));
      assert.equal(await getPlaylistSourceById(id), null);
      await runWithTenantId(otherTenant, async () => {
        assert.equal((await getPlaylistSourceById(id)).label, 'Other user');
      });
    } finally {
      if (otherDir) await fs.rm(otherDir, { recursive: true, force: true });
    }
  });
});

test('custom days replaces 50 scans: account survives 50 failures before deadline and deletes at deadline', async () => {
  await fixture(async ({ id }) => {
    await updateAppSettings({ automaticDeleteDays: 3 });
    for (let i = 1; i <= 50; i++) await scanAccounts([id], automatic(i));
    assert.ok(await getPlaylistSourceById(id));
    assert.equal((await getPersistentFailureStatus()).automaticDeleteDays, 3);
    const first = Date.parse(automatic(1).scannedAt);
    await scanAccounts([id], { automatic: true, scannedAt: new Date(first + 3 * 86400000 - 1).toISOString() });
    assert.ok(await getPlaylistSourceById(id));
    await scanAccounts([id], { automatic: true, scannedAt: new Date(first + 3 * 86400000).toISOString() });
    assert.equal(await getPlaylistSourceById(id), null);
  });
});

test('active result resets the day clock; manual failure cannot delete even after deadline', async () => {
  await fixture(async ({ id }) => {
    await updateAppSettings({ automaticDeleteDays: 1 });
    await scanAccounts([id], automatic(1));
    globalThis.fetch = async () => new Response('#EXTM3U\n', { status: 200 });
    await scanAccount(id);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await scanAccounts([id], automatic(2000));
    await scanAccounts([id], automatic(2001));
    await scanAccounts([id], automatic(2002));
    assert.ok(await getPlaylistSourceById(id));
    const record = (await getPersistentFailureStatus()).accounts[id];
    assert.equal(record.firstAutomaticFailureAt, automatic(2000).scannedAt);
    await scanAccount(id);
    assert.ok(await getPlaylistSourceById(id));
  });
});

test('day settings persist, reject invalid input, and retain old mode when unset', async () => {
  await fixture(async () => {
    const { getAppSettings } = await import('../src/modules/appSettingsService.js');
    assert.equal((await getAppSettings()).automaticDeleteDays, 0);
    await updateAppSettings({ automaticDeleteDays: 14 });
    assert.equal((await getAppSettings()).automaticDeleteDays, 14);
    for (const invalid of [-1, 1.5, 3651, '7', null]) {
      await assert.rejects(updateAppSettings({ automaticDeleteDays: invalid }), /tam gun/);
    }
    assert.equal((await getAppSettings()).automaticDeleteDays, 14);
  });
});

test('user-defined scan count deletes exactly on the selected automatic failure', async () => {
  await fixture(async ({ id }) => {
    await updateAppSettings({ automaticDeleteDays: 0, automaticDeleteScans: 4 });
    for (let i = 1; i <= 3; i++) await scanAccounts([id], automatic(i));
    assert.ok(await getPlaylistSourceById(id));
    const status = await getPersistentFailureStatus();
    assert.equal(status.automaticDeleteThreshold, 4);
    assert.equal(status.accounts[id].consecutiveFailures, 3);
    await scanAccounts([id], automatic(4));
    assert.equal(await getPlaylistSourceById(id), null);
  });
});

test('scan count accepts arbitrary whole numbers and rejects invalid values', async () => {
  await fixture(async () => {
    const { getAppSettings } = await import('../src/modules/appSettingsService.js');
    await updateAppSettings({ automaticDeleteScans: 1234 });
    assert.equal((await getAppSettings()).automaticDeleteScans, 1234);
    for (const invalid of [0, -1, 1.5, 10001, '34', null]) {
      await assert.rejects(updateAppSettings({ automaticDeleteScans: invalid }), /Tarama sayisi/);
    }
    assert.equal((await getAppSettings()).automaticDeleteScans, 1234);
  });
});
