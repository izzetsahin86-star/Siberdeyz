const MAIL_HOSTS = new Set(['my.mail.ru', 'm.my.mail.ru']);

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeInput(value) {
  const raw = String(value || '').trim();
  if (!raw) throw httpError('Mail.ru video linki gerekli');
  let url;
  try { url = new URL(raw); } catch { throw httpError('Gecerli bir URL girin'); }
  if (!MAIL_HOSTS.has(url.hostname.toLowerCase())) throw httpError('Yalnizca my.mail.ru video linkleri destekleniyor');
  return url;
}

function extractVideoId(url) {
  const embed = url.pathname.match(/\/video\/embed\/(\d+)/i);
  if (embed) return embed[1];
  return null;
}

async function fetchText(url, accept = 'text/html,*/*') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept,
        'accept-language': 'tr-TR,tr;q=0.9,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
      },
    });
    if (!response.ok) throw httpError('Mail.ru yanit vermedi: HTTP ' + response.status, 502);
    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') throw httpError('Mail.ru istegi zaman asimina ugradi', 504);
    throw error;
  } finally { clearTimeout(timer); }
}

function findMetaUrlInHtml(html) {
  const script = html.match(/<script[^>]+class=["'][^"']*sp-video__page-config[^"']*["'][^>]*>([\s\S]+?)<\/script>/i);
  if (script) {
    try {
      const config = JSON.parse(script[1].trim());
      const value = config?.metaUrl || config?.video?.metaUrl;
      if (value) return new URL(value, 'https://my.mail.ru').href;
    } catch {}
  }
  const escaped = html.match(/["']metaUrl["']\s*:\s*["']([^"']+)["']/i);
  if (escaped) {
    const value = escaped[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    try { return new URL(value, 'https://my.mail.ru').href; } catch {}
  }
  return null;
}

function findIdInHtml(html) {
  const patterns = [
    /video\/embed\/(\d{10,})/i,
    /["'](?:videoId|video_id|id)["']\s*:\s*["']?(\d{10,})/i,
    /meta\/(\d{10,})/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function normalizeMediaUrl(value) {
  const raw = String(value || '').trim().replace(/\\u0026/g, '&').replace(/\\\//g, '/');
  if (!raw) return '';
  if (raw.startsWith('//')) return 'https:' + raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return '';
}

function collectVideos(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectVideos(item, out);
    return out;
  }
  if (typeof value !== 'object') return out;

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string') {
      const url = normalizeMediaUrl(child);
      const mediaKey = /^(url|src|file|video|stream|hls|mp4)$/i.test(key);
      const looksMedia = /\.m3u8(?:\?|$)/i.test(url) || /\.mp4(?:\?|$)/i.test(url) || /\/hv\//i.test(url) || /cdn\d*\.my\.mail\.ru/i.test(url);
      if (url && (mediaKey || looksMedia) && !/\.(?:jpg|jpeg|png|gif|webp|css|js)(?:\?|$)/i.test(url)) {
        out.push({ url, quality: String(value.key || value.quality || value.name || value.label || key || 'auto') });
      }
    } else if (child && typeof child === 'object') {
      collectVideos(child, out);
    }
  }
  return out;
}
function uniqueVideos(videos) {
  const seen = new Set();
  return videos.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function qualityScore(label) {
  const n = Number(String(label).match(/\d{3,4}/)?.[0] || 0);
  return n;
}

export async function resolveMailRuVideo(input) {
  const pageUrl = normalizeInput(input);
  let videoId = extractVideoId(pageUrl);
  let metaUrl = videoId ? 'https://my.mail.ru/+/video/meta/' + encodeURIComponent(videoId) : null;
  if (!metaUrl) {
    const html = await fetchText(pageUrl.href);
    metaUrl = findMetaUrlInHtml(html);
    videoId = findIdInHtml(html) || String(metaUrl || '').match(/\/meta\/(\d+)/i)?.[1] || pageUrl.pathname.match(/\/(\d+)\.html$/i)?.[1] || null;
  }
  if (!metaUrl) throw httpError('Mail.ru video metadata adresi bulunamadi', 422);

  const raw = await fetchText(metaUrl, 'application/json,text/plain,*/*');
  let data;
  try { data = JSON.parse(raw); } catch { throw httpError('Mail.ru metadata okunamadi', 502); }

  const videos = uniqueVideos(collectVideos(data)).sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality));
  if (!videos.length) throw httpError('Oynatilabilir MP4/M3U8 adresi bulunamadi', 404);

  const title = String(data?.meta?.title || data?.title || ('Mail.ru ' + videoId)).replace(/[\r\n]+/g, ' ').trim();
  const best = videos[0];
  const m3u = '#EXTM3U\n#EXTINF:-1,' + title + '\n' + best.url + '\n';
  return { videoId: videoId || 'video', title, sourceUrl: pageUrl.href, best, videos, m3u };
}
