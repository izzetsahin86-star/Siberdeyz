const COMMON_HEIGHTS = new Set([144, 180, 240, 288, 360, 432, 480, 540, 576, 720, 900, 1080, 1440, 2160, 4320]);
const QUALITY_PARAM_NAMES = new Set([
  'quality', 'q', 'res', 'resolution', 'height', 'videoquality', 'video_quality',
  'rendition', 'variant', 'profile', 'size',
]);
const WORD_QUALITY = new Map([
  ['sd', 480], ['hd', 720], ['fhd', 1080], ['fullhd', 1080], ['full-hd', 1080],
  ['qhd', 1440], ['uhd', 2160], ['4k', 2160], ['8k', 4320],
]);

function decoded(value) {
  try { return decodeURIComponent(String(value || '')); }
  catch { return String(value || ''); }
}

function numericHeight(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) && COMMON_HEIGHTS.has(number) ? number : 0;
}

function qualityFromText(value) {
  const text = decoded(value).toLowerCase();
  let best = 0;

  for (const match of text.matchAll(/(?:^|[^0-9])(\d{3,4})\s*[x×]\s*(\d{3,4})(?:[^0-9]|$)/g)) {
    best = Math.max(best, numericHeight(match[2]));
  }
  for (const match of text.matchAll(/(?:^|[^0-9])(144|180|240|288|360|432|480|540|576|720|900|1080|1440|2160|4320)\s*[pi](?:[^a-z0-9]|$)/g)) {
    best = Math.max(best, numericHeight(match[1]));
  }
  for (const match of text.matchAll(/(?:^|[\/_\-.?=&])(144|180|240|288|360|432|480|540|576|720|900|1080|1440|2160|4320)(?=$|[\/_\-.?=&])/g)) {
    best = Math.max(best, numericHeight(match[1]));
  }
  for (const [word, height] of WORD_QUALITY) {
    const pattern = new RegExp('(?:^|[^a-z0-9])' + word.replace('-', '\\-') + '(?:[^a-z0-9]|$)', 'i');
    if (pattern.test(text)) best = Math.max(best, height);
  }
  return best;
}

export function extractQualityHeight(...values) {
  let best = 0;
  for (const value of values) {
    if (Number.isFinite(Number(value))) best = Math.max(best, numericHeight(value));
    best = Math.max(best, qualityFromText(value));
    try {
      const parsed = new URL(String(value || ''));
      for (const [name, paramValue] of parsed.searchParams) {
        if (!QUALITY_PARAM_NAMES.has(name.toLowerCase())) continue;
        best = Math.max(best, numericHeight(paramValue), qualityFromText(paramValue));
      }
    } catch {}
  }
  return best || null;
}

function normalizeQualityTokens(value) {
  return decoded(value)
    .toLowerCase()
    .replace(/(?:\d{3,4})\s*[x×]\s*(?:144|180|240|288|360|432|480|540|576|720|900|1080|1440|2160|4320)(?=$|[^0-9])/g, '{resolution}')
    .replace(/(^|[\/_\-.])(?:144|180|240|288|360|432|480|540|576|720|900|1080|1440|2160|4320)p?(?=$|[\/_\-.])/g, '$1{quality}')
    .replace(/(^|[\/_\-.])(?:sd|hd|fhd|fullhd|full-hd|qhd|uhd|4k|8k)(?=$|[\/_\-.])/g, '$1{quality}');
}

export function qualityVariantKey(candidate = {}) {
  const rawUrl = String(candidate.url || '');
  const height = extractQualityHeight(candidate.qualityHeight, rawUrl, candidate.title, candidate.name);
  if (!rawUrl) return 'missing:' + normalizeQualityTokens(candidate.title || candidate.name || '');

  try {
    const parsed = new URL(rawUrl);
    if (!height) return 'exact:' + parsed.toString();

    const pathname = normalizeQualityTokens(parsed.pathname);
    const params = [];
    for (const [rawName, rawValue] of parsed.searchParams) {
      const name = rawName.toLowerCase();
      const value = QUALITY_PARAM_NAMES.has(name) ? '{quality}' : normalizeQualityTokens(rawValue);
      params.push([name, value]);
    }
    params.sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));
    const query = params.map(([name, value]) => name + '=' + value).join('&');
    return 'variant:' + parsed.hostname.toLowerCase() + pathname + (query ? '?' + query : '');
  } catch {
    return 'text:' + normalizeQualityTokens(rawUrl);
  }
}

export function groupQualityVariantCandidates(candidates = []) {
  const groups = new Map();

  for (const candidate of candidates) {
    const qualityHeight = extractQualityHeight(
      candidate.qualityHeight,
      candidate.url,
      candidate.title,
      candidate.name,
    );
    const enriched = { ...candidate, qualityHeight };
    const key = qualityVariantKey(enriched);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(enriched);
  }

  return [...groups.values()].map((group) => group.sort((left, right) => (
    Number(right.qualityHeight || 0) - Number(left.qualityHeight || 0)
    || Number(right.confidence || 0) - Number(left.confidence || 0)
  )));
}
