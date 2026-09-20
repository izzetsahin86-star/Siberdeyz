import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractMediaCandidatesFromText,
  extractPageLinks,
  mediaKind,
  normalizeSearchText,
  queryScore,
} from '../src/modules/mediaFinderPro/extractors.js';
import {
  isBlockedHostname,
  isPrivateIp,
  isSameSite,
  normalizeHttpUrl,
} from '../src/modules/mediaFinderPro/urlSafety.js';
import { parseMp4Duration } from '../src/modules/mediaFinderPro/probe.js';
import { mediaFinderProV2ClientSnapshot } from '../src/modules/mediaFinderProV2/clientSnapshot.js';

test('normalizes public web addresses without accepting unsafe protocols', () => {
  assert.equal(normalizeHttpUrl('example.com/watch').toString(), 'https://example.com/watch');
  assert.equal(normalizeHttpUrl('http://example.com/video').protocol, 'http:');
  assert.throws(() => normalizeHttpUrl('file:///etc/passwd'), /Yalnizca http/);
  assert.throws(() => normalizeHttpUrl('https://user:pass@example.com'), /sifre iceren/);
});

test('recognizes private networks and internal hostnames', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('10.4.5.6'), true);
  assert.equal(isPrivateIp('172.20.1.2'), true);
  assert.equal(isPrivateIp('192.168.1.10'), true);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('::ffff:7f00:1'), true);
  assert.equal(isPrivateIp('::ffff:c0a8:10a'), true);
  assert.equal(isPrivateIp('::ffff:0808:0808'), false);
  assert.equal(isBlockedHostname('metadata.google.internal'), true);
  assert.equal(isBlockedHostname('video.example.com'), false);
});

test('matches the main site and its mobile or player subdomains', () => {
  assert.equal(isSameSite('www.example.com', 'm.example.com'), true);
  assert.equal(isSameSite('example.com', 'player.example.com'), true);
  assert.equal(isSameSite('example.com', 'example.net'), false);
});

test('scores Turkish film and actor names with normalized accents', () => {
  assert.equal(normalizeSearchText('Çağatay ÜLUSOY: Film'), 'cagatay ulusoy film');
  assert.ok(queryScore('Çağatay Ulusoy yeni filmi izle', 'cagatay ulusoy') >= 50);
  assert.ok(queryScore('Baska bir oyuncu', 'cagatay ulusoy') < 10);
});

test('extracts absolute, relative and escaped media URLs without duplicates', () => {
  const html = [
    '<video src="/media/movie.mp4?token=1"></video>',
    '<script>const stream = "https:\\/\\/cdn.example.com\\/live\\/master.m3u8?key=abc";</script>',
    '<script>file: "/media/movie.mp4?token=1"</script>',
  ].join('');

  const candidates = extractMediaCandidatesFromText(html, 'https://example.com/watch/42');
  assert.deepEqual(candidates.map((item) => item.url).sort(), [
    'https://cdn.example.com/live/master.m3u8?key=abc',
    'https://example.com/media/movie.mp4?token=1',
  ]);
  assert.deepEqual(candidates.map((item) => mediaKind(item.url)).sort(), ['HLS', 'MP4']);
});

test('keeps crawl links on the requested site and prioritizes matching titles', () => {
  const html = [
    '<a href="/film/ornek-film-izle">Örnek Film izle</a>',
    '<a href="https://player.example.com/watch/7">Örnek Film oynatıcı</a>',
    '<a href="https://unrelated.test/watch/7">Örnek Film dış kaynak</a>',
  ].join('');

  const links = extractPageLinks(html, 'https://example.com', 'example.com', 'Ornek Film');
  assert.equal(links.length, 2);
  assert.ok(links.every((item) => item.url.includes('example.com')));
  assert.ok(links[0].score >= links[1].score);
});

test('reads movie duration from an MP4 mvhd atom without an external process', () => {
  const versionZero = Buffer.alloc(28);
  versionZero.write('mvhd', 4, 'ascii');
  versionZero.writeUInt8(0, 8);
  versionZero.writeUInt32BE(1_000, 20);
  versionZero.writeUInt32BE(120_000, 24);

  assert.equal(parseMp4Duration(versionZero), 120);
  assert.equal(parseMp4Duration(Buffer.from('not an mp4')), null);
});

test('keeps Pro V2 polling payload small without exposing stream URLs', () => {
  const snapshot = mediaFinderProV2ClientSnapshot({
    jobId: 'job-1',
    status: 'running',
    progress: { accepted: 1 },
    results: [{
      id: 'stream-1',
      name: 'Ornek Film',
      url: 'https://cdn.example.com/movie.m3u8?very-long-token=secret',
      kind: 'HLS',
      discoveredBy: 'v2-response',
    }],
  });

  assert.deepEqual(snapshot.results, [{
    id: 'stream-1',
    name: 'Ornek Film',
    kind: 'HLS',
    discoveredBy: 'v2-response',
  }]);
  assert.equal(JSON.stringify(snapshot).includes('very-long-token'), false);
});
