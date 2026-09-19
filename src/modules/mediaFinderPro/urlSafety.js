import dns from 'dns/promises';
import net from 'net';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 Siberdeyz-Media-Finder-Pro/1.0';
const MAX_REDIRECTS = 5;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function normalizeHttpUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw httpError('Site veya yayin baglantisi girin.');

  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? input
    : ('https://' + input.replace(/^\/+/, ''));

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw httpError('Gecerli bir site veya yayin baglantisi girin.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw httpError('Yalnizca http veya https baglantilari kullanilabilir.');
  }

  if (parsed.username || parsed.password) {
    throw httpError('Kullanici adi veya sifre iceren baglantilar taranamaz.');
  }

  parsed.hash = '';
  return parsed;
}

function isPrivateIpv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  if (!value || value === '::' || value === '::1') return true;
  if (value.startsWith('fc') || value.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(value)) return true;
  if (value.startsWith('ff')) return true;
  if (value.startsWith('2001:db8:')) return true;

  const dotted = value.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIpv4(dotted[1]);

  if (value.startsWith('::ffff:')) {
    const words = value.slice('::ffff:'.length).split(':').filter(Boolean);
    if (words.length === 2 && words.every((word) => /^[0-9a-f]{1,4}$/i.test(word))) {
      const high = Number.parseInt(words[0], 16);
      const low = Number.parseInt(words[1], 16);
      const mappedIpv4 = [high >> 8, high & 255, low >> 8, low & 255].join('.');
      return isPrivateIpv4(mappedIpv4);
    }
  }

  return false;
}

export function isPrivateIp(address) {
  const family = net.isIP(String(address || ''));
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return (
    !host
    || host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home')
    || host.endsWith('.lan')
    || host === 'metadata.google.internal'
  );
}

export async function assertPublicHttpUrl(value) {
  const parsed = value instanceof URL ? new URL(value) : normalizeHttpUrl(value);
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (isBlockedHostname(host)) {
    throw httpError('Yerel veya ozel ag adresleri taranamaz.');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw httpError('Yerel veya ozel IP adresleri taranamaz.');
    return parsed;
  }

  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw httpError('Baglanti adresi cozumlenemedi.');
  }

  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw httpError('Yerel veya ozel ag hedefleri taranamaz.');
  }

  return parsed;
}

export async function safeFetch(value, options = {}, redirectsLeft = MAX_REDIRECTS) {
  const parsed = await assertPublicHttpUrl(value);
  const response = await fetch(parsed, {
    ...options,
    redirect: 'manual',
    headers: {
      'user-agent': DEFAULT_USER_AGENT,
      accept: '*/*',
      ...(options.headers || {}),
    },
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});

    if (!location) throw httpError('Yonlendirme hedefi bulunamadi.', 502);
    if (redirectsLeft <= 0) throw httpError('Cok fazla yonlendirme var.', 502);

    const next = new URL(location, parsed).toString();
    return safeFetch(next, options, redirectsLeft - 1);
  }

  return response;
}

export async function readTextLimited(response, maxBytes = 1_500_000) {
  if (!response.body?.getReader) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      chunks.push(chunk.subarray(0, remaining));
      total += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString('utf-8');
}

export function canonicalPageUrl(value) {
  try {
    const parsed = normalizeHttpUrl(value);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

export function comparableSiteHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^(?:www|m|amp)\./, '');
}

export function isSameSite(rootHostname, candidateHostname) {
  const root = comparableSiteHost(rootHostname);
  const candidate = comparableSiteHost(candidateHostname);
  return Boolean(root && candidate && (
    candidate === root
    || candidate.endsWith('.' + root)
  ));
}

export const MEDIA_FINDER_USER_AGENT = DEFAULT_USER_AGENT;
