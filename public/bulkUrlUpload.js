const BULK_FILE_TYPES = [
  '.m3u',
  '.m3u8',
  '.txt',
  '.csv',
  '.tsv',
  'application/vnd.apple.mpegurl',
  'audio/x-mpegurl',
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
].join(',');

export function enhanceBulkUrlFileInput(root = document) {
  const input = root.querySelector('#sourceFileInput');
  if (!input) return false;

  input.accept = BULK_FILE_TYPES;
  input.setAttribute('aria-label', 'M3U, TXT, CSV veya TSV dosyalarindan hesap ekle');

  const hint = input.closest('.file-upload-card')?.querySelector('small');
  if (hint) hint.textContent = 'M3U / TXT / CSV';
  return true;
}

enhanceBulkUrlFileInput();
