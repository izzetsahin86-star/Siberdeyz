import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getTenantDataDir, runWithTenantId } from '../src/modules/tenantContext.js';
import { getAppSettings, updateAppSettings } from '../src/modules/appSettingsService.js';
import { withHeavyTask } from '../src/modules/resourceBudget.js';
import { verifyXtreamStreams } from '../src/modules/accountStreamVerifier.js';

test('legacy 120-minute setting migrates to 24 hours without changing other preferences', async () => {
  const tenant = 'scan-budget-test-' + randomUUID();
  await runWithTenantId(tenant, async () => {
    const dir = getTenantDataDir();
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify({
        autoScanMinutes: 120,
        automaticDeleteDays: 14,
        automaticDeleteScans: 83,
        failureThreshold: 5,
      }));
      const settings = await getAppSettings();
      assert.equal(settings.autoScanMinutes, 1440);
      assert.equal(settings.automaticDeleteDays, 14);
      assert.equal(settings.automaticDeleteScans, 83);
      assert.equal(settings.failureThreshold, 5);
      await updateAppSettings({ autoScanMinutes: 1440 });
      assert.equal((await getAppSettings()).autoScanMinutes, 1440);
      await updateAppSettings({ autoScanMinutes: 0 });
      assert.equal((await getAppSettings()).autoScanMinutes, 0);
      await updateAppSettings({ autoScanMinutes: 60 });
      assert.equal((await getAppSettings()).autoScanMinutes, 60);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test('heavy operations never overlap and failure releases the slot', async () => {
  const events = [];
  let release;
  const first = withHeavyTask(async () => {
    events.push('first-start');
    await new Promise((resolve) => { release = resolve; });
    events.push('first-end');
  });
  const second = withHeavyTask(async () => {
    events.push('second-start');
    events.push('second-end');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start', 'second-end']);
  await assert.rejects(withHeavyTask(async () => { throw new Error('test failure'); }), /test failure/);
  assert.equal(await withHeavyTask(async () => 42), 42);
});

test('oversized live-stream catalog is skipped safely without marking account definitively failed', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return new Response('[]', {
        status: 200,
        headers: { 'content-length': String(8 * 1024 * 1024 + 1) },
      });
    };
    const result = await verifyXtreamStreams({
      url: 'https://provider.invalid/get.php?username=sample&password=sample',
    });
    assert.equal(calls, 1);
    assert.equal(result.verified, false);
    assert.equal(result.definitiveFailure, false);
    assert.match(result.message, /bellek guvenligi/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normal small Xtream catalog still verifies a real stream', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('get_live_streams')) {
        return new Response(JSON.stringify([{ stream_id: 7, container_extension: 'ts' }]), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      assert.match(url, /\/live\//);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const result = await verifyXtreamStreams({
      url: 'https://provider.invalid/get.php?username=sample&password=sample',
    });
    assert.equal(result.verified, true);
    assert.equal(result.verifiedStreams, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
