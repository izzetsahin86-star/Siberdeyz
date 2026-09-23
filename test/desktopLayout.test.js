import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { attachDesktopLayout, isDesktopDevice } from '../public/desktopLayout.js';

test('desktop eligibility excludes iOS, including iPad desktop mode with a mouse', () => {
  assert.equal(isDesktopDevice({ userAgent: 'iPhone', platform: 'iPhone' }, true), false);
  assert.equal(isDesktopDevice({ userAgent: 'iPad', platform: 'iPad' }, true), false);
  assert.equal(isDesktopDevice({ userAgent: 'Macintosh Safari', platform: 'MacIntel', maxTouchPoints: 5 }, true), false);
  assert.equal(isDesktopDevice({ userAgent: 'Windows', platform: 'Win32', maxTouchPoints: 10 }, true), true);
  assert.equal(isDesktopDevice({ userAgent: 'Macintosh Safari', platform: 'MacIntel', maxTouchPoints: 0 }, true), true);
  assert.equal(isDesktopDevice({ userAgent: 'Windows', platform: 'Win32' }, false), false);
});

test('desktop adapter preserves mobile DOM, player identity, fields and existing event handlers across resizing', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.MutationObserver = window.MutationObserver;
  let resize;
  const media = { matches: false, addEventListener: (_, listener) => { resize = listener; } };
  window.matchMedia = () => media;
  const document = window.document;
  const player = document.querySelector('#player');
  const panel = document.querySelector('#bottomPanel');
  const field = document.querySelector('#sourceNameInput');
  field.value = 'Unsaved account name';
  let existingClicks = 0;
  document.querySelector('[data-action="next"]').addEventListener('click', () => existingClicks++);
  const original = document.documentElement.outerHTML;
  const panels = [];
  try {
    attachDesktopLayout({ openPanel: name => panels.push(name) });
    assert.equal(document.documentElement.outerHTML, original, 'mobile DOM must remain byte-identical');
    media.matches = true;
    resize();
    assert.equal(document.documentElement.dataset.desktopLayout, 'true');
    assert.equal(document.querySelector('#player'), player);
    assert.equal(document.querySelectorAll('video').length, 1);
    document.querySelector('[data-action="next"]').click();
    assert.equal(existingClicks, 1);
    assert.equal(field.value, 'Unsaved account name');
    panel.dataset.open = 'settings';
    await Promise.resolve();
    assert.equal(document.querySelector('.desktop-heading h1').textContent, 'Ayarlar');
    assert.equal(document.querySelector('[data-panel="settings"]').getAttribute('aria-pressed'), 'true');

    document.querySelector('#appShell').hidden = false;
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.deepEqual(panels, ['channels']);
    assert.equal(document.activeElement.id, 'searchInput');
    field.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(panels.length, 1, 'typing in a field must not navigate');
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '4', altKey: true, bubbles: true }));
    assert.deepEqual(panels, ['channels', 'settings']);
    player.setAttribute('src', '/test-only.mp4');
    await Promise.resolve();
    assert.equal(document.querySelector('.desktop-player-empty').hidden, true);

    media.matches = false;
    resize();
    assert.equal(document.documentElement.hasAttribute('data-desktop-layout'), false);
    assert.equal(document.querySelector('.desktop-brand'), null);
    assert.equal(document.querySelector('[data-panel="settings"]').hasAttribute('aria-pressed'), false);
    assert.equal(document.querySelector('#player'), player);
    assert.equal(player.getAttribute('src'), '/test-only.mp4');
    assert.equal(field.value, 'Unsaved account name');
    document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
    assert.equal(panels.length, 2, 'desktop shortcuts must stop on mobile');
    media.matches = true;
    resize();
    resize();
    assert.equal(document.querySelectorAll('.desktop-brand').length, 1, 'no duplicate UI on resize');
  } finally {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.MutationObserver;
  }
});

test('every desktop style requires both the desktop viewport and the device gate', () => {
  const dom = new JSDOM('<style></style>');
  dom.window.document.querySelector('style').textContent = readFileSync(new URL('../public/desktopLayout.css', import.meta.url), 'utf8');
  const rules = [...dom.window.document.styleSheets[0].cssRules];
  assert.ok(rules.length > 0);
  for (const media of rules) {
    assert.match(media.conditionText, /min-width: 1024px/);
    assert.match(media.conditionText, /pointer: fine/);
    assert.match(media.conditionText, /hover: hover/);
    for (const rule of media.cssRules) {
      assert.ok(rule.selectorText.startsWith('html[data-desktop-layout="true"]'));
    }
  }
  dom.window.close();
});
