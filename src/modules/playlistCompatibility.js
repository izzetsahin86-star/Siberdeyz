export function getPlaylistFetchCandidates(value) {
  const original = String(value || '').trim();
  if (!original) return [];

  const candidates = [];

  try {
    const parsed = new URL(original);
    const path = parsed.pathname.toLocaleLowerCase('tr-TR');
    const hasLogin = parsed.searchParams.has('username') && parsed.searchParams.has('password');
    const isXtreamGet = hasLogin && /\/get\.php$/i.test(path);

    if (isXtreamGet) {
      const hlsPreferred = new URL(parsed.toString());
      hlsPreferred.searchParams.set('output', 'm3u8');
      candidates.push(hlsPreferred.toString());
    }
  } catch {
    // Gecersiz kaynak URL, mevcut akis kendi hatasini uretecek.
  }

  if (!candidates.includes(original)) {
    candidates.push(original);
  }

  return candidates;
}

export function isHlsStreamUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return /\.m3u8$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}
