// Optional local regression check. npm install --no-save playwright, then npx playwright install chromium.
// Runs against an isolated temporary data directory; never uses production accounts.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'siberdeyz-ui-'));
const output = process.env.UI_TEST_OUTPUT || path.join(temp, 'screenshots');
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, [path.join(root, 'src/server.js')], {
  cwd: temp, env: { ...process.env, PORT: '3131', ADMIN_PASSWORD: 'local-interface-test', SESSION_SECRET: 'local-interface-test-secret' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Local server startup timed out')), 10000);
    server.stdout.on('data', data => { if (String(data).includes('listening')) { clearTimeout(timeout); resolve(); } });
    server.once('error', reject);
    server.once('exit', code => reject(new Error(`Server exited: ${code}`)));
  });
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_EXECUTABLE || undefined, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3131');
  await page.locator('#adminPasswordInput').fill('local-interface-test');
  await page.locator('#loginButton').click();
  await page.locator('#appShell').waitFor({ state: 'visible' });
  await page.locator('#closePanelButton').click();
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(output, 'aurora-home.png') });
  for (const size of [{width:393,height:852},{width:320,height:700},{width:852,height:393},{width:1280,height:900}]) {
    await page.setViewportSize(size);
    for (const panel of ['channels', 'accounts', 'webscan', 'settings']) {
      await page.locator(`[data-panel="${panel}"]`).click();
      await page.locator(`#${panel === 'webscan' ? 'webScan' : panel}View`).waitFor({state:'visible'});
      await page.waitForTimeout(300); // The legacy sheet transition is 260 ms.
      const layout = await page.evaluate(() => {
        const rect = document.querySelector('#bottomPanel').getBoundingClientRect();
        const dock = document.querySelector('.control-panel').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, panelTop: rect.top, panelBottom: rect.bottom, dockTop: dock.top, width: innerWidth };
      });
      assert.equal(layout.overflow, false, `${size.width}: ${panel} overflows horizontally`);
      if (size.width <= 860) {
        assert(layout.panelTop >= 0, `${panel} extends above viewport`);
        assert(layout.panelBottom <= layout.dockTop + 1, `${size.width}: ${panel} overlaps dock: ${JSON.stringify(layout)}`);
      }
      if (size.width === 393) await page.screenshot({path:path.join(output, `aurora-${panel}.png`)});
      await page.locator('#closePanelButton').click();
    }
  }
  await page.setViewportSize({width:393,height:852});
  // Existing account upload, channel selection, favorite, search and stop handlers.
  await page.locator('[data-panel="accounts"]').click();
  await page.locator('#sourceFileInput').setInputFiles({name:'interface-test.m3u',mimeType:'text/plain',buffer:Buffer.from('#EXTM3U\n#EXTINF:-1 group-title="Test",Arayüz Test Kanalı\nhttps://example.com/interface-test.mp4\n')});
  await page.locator('.source-pill-item').waitFor({state:'attached'});
  await page.locator('.channel').first().waitFor();
  await page.locator('.favorite-button').first().click();
  await page.waitForFunction(() => document.querySelector('.favorite-button')?.classList.contains('is-active'));
  await page.locator('#searchInput').fill('bulunamayan-kanal');
  await page.waitForFunction(() => document.querySelectorAll('.channel').length === 0);
  await page.locator('#searchInput').fill('');
  await page.locator('.channel').first().waitFor();
  // Intercept only the synthetic media URL; production services are never contacted.
  const clip = path.join(temp, 'test.webm');
  execFileSync('ffmpeg', ['-v','error','-f','lavfi','-i','color=c=teal:s=320x180:r=15','-t','20','-c:v','libvpx','-b:v','80k',clip]);
  const media = await readFile(clip);
  await page.route('https://example.com/**', route => route.fulfill({status:200,contentType:'video/webm',body:media}));
  await page.locator('.channel').first().click();
  await page.waitForFunction(() => document.querySelector('#currentChannel').textContent.includes('Arayüz Test Kanalı'));
  await page.waitForFunction(() => document.querySelector('#player').currentTime > .1);
  const video = await page.locator('#player').elementHandle();
  const before = await video.evaluate(el => ({src:el.getAttribute('src'), muted:el.muted}));
  await page.locator('.interface-toggle').click();
  assert.equal(await page.locator('html').getAttribute('data-interface'), 'classic');
  assert(await video.evaluate(el => el === document.querySelector('#player')), 'Video element was replaced');
  assert.deepEqual(await video.evaluate(el => ({src:el.getAttribute('src'), muted:el.muted})), before);
  await page.locator('.interface-toggle').click();
  assert(await video.evaluate(el => !el.paused && el.currentTime > .1), 'Playback did not continue');
  await page.locator('[data-action="stop"]').click();
  await page.locator('[data-panel="settings"]').click();
  await page.locator('#interfaceMode').selectOption('classic');
  await page.reload();
  assert.equal(await page.locator('html').getAttribute('data-interface'), 'classic');
  await page.goto('http://127.0.0.1:3131/?interface=aurora');
  assert.equal(await page.locator('html').getAttribute('data-interface'), 'aurora');
  await page.goto('http://127.0.0.1:3131/?interface=classic');
  assert.equal(await page.locator('html').getAttribute('data-interface'), 'classic');
  assert.deepEqual(errors, []);
  console.log('PASS: 16 panel/viewport combinations; upload, search, favorite, selection, stop, live DOM preservation, persisted rollback and URL override.');
  console.log(`Screenshots: ${output}`);
} finally { await browser?.close(); server.kill(); }
