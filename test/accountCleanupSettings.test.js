import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createAppSettingsController } from '../public/appSettings.js';

test('settings UI loads saved days, saves exact day value, validates input and can restore 50 scans', async () => {
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  const previousFetch = globalThis.fetch;
  globalThis.document = dom.window.document;
  let saved = { automaticDeleteDays: 14, automaticDeleteScans: 83 };
  const patches = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/settings');
    if (options?.method === 'PUT') {
      const patch = JSON.parse(options.body);
      patches.push(patch);
      saved = { ...saved, ...patch };
    }
    return new Response(JSON.stringify(saved), { status: 200 });
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    const controller = createAppSettingsController();
    await controller.load();
    const mode = document.querySelector('#accountCleanupMode');
    const days = document.querySelector('#accountCleanupDays');
    const scans = document.querySelector('#accountCleanupScans');
    const button = document.querySelector('#saveAccountCleanupDays');
    assert.equal(mode.value, 'days');
    assert.equal(days.value, '14');
    assert.equal(days.disabled, false);
    assert.equal(scans.value, '83');
    assert.equal(scans.disabled, true);
    days.value = '9';
    button.click();
    await settle();
    assert.deepEqual(patches, [{ automaticDeleteDays: 9, automaticDeleteScans: 83 }]);
    assert.equal(controller.getSettings().automaticDeleteDays, 9);
    days.value = '0';
    button.click();
    await settle();
    assert.equal(patches.length, 1);
    mode.value = 'scans';
    mode.dispatchEvent(new dom.window.Event('change'));
    assert.equal(days.disabled, true);
    assert.equal(scans.disabled, false);
    scans.value = '1234';
    button.click();
    await settle();
    assert.deepEqual(patches[1], { automaticDeleteDays: 0, automaticDeleteScans: 1234 });
  } finally {
    dom.window.close();
    delete globalThis.document;
    globalThis.fetch = previousFetch;
  }
});
