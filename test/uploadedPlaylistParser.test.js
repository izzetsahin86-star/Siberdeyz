import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUploadedPlaylist } from '../src/modules/uploadedPlaylistParser.js';

const urls = [
  'http://devicejust.xyz:8080/get.php?username=ruZQS7JQ&password=ddWHuWQ&type=m3u_plus',
  'http://devicejust.xyz:8080/get.php?username=BurakAile2024&password=dxKWa7sYxc&type=m3u_plus',
  'http://devicejust.xyz:8080/get.php?username=xgtRSywaBt&password=s865r9tmNn&type=m3u_plus',
];

test('numbered TXT rows are imported as separate URL accounts', () => {
  const content = urls.map((url, index) => `${index + 1}\t${url}`).join('\n');
  const parsed = parseUploadedPlaylist(content, 'hesaplar.txt');

  assert.equal(parsed.kind, 'sources');
  assert.equal(parsed.total, 3);
  assert.deepEqual(parsed.sources.map((source) => source.url), urls);
  assert.deepEqual(parsed.sources.map((source) => source.label), [
    'devicejust.xyz - ruZQS7JQ',
    'devicejust.xyz - BurakAile2024',
    'devicejust.xyz - xgtRSywaBt',
  ]);
});

test('common sequence markers are not used as account labels', () => {
  const content = [`1. ${urls[0]}`, `2) ${urls[1]}`, `"3","${urls[2]}"`].join('\n');
  const parsed = parseUploadedPlaylist(content, 'hesaplar.csv');

  assert.equal(parsed.total, 3);
  assert.ok(parsed.sources.every((source) => source.label.startsWith('devicejust.xyz - ')));
});

test('duplicate account rows in a bulk file are imported once', () => {
  const parsed = parseUploadedPlaylist(`1\t${urls[0]}\n2\t${urls[0]}`, 'hesaplar.tsv');

  assert.equal(parsed.kind, 'sources');
  assert.equal(parsed.total, 1);
  assert.equal(parsed.sources[0].url, urls[0]);
});
