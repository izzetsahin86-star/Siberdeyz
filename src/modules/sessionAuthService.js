import crypto from 'crypto';
import { config } from '../config.js';

const COOKIE_NAME = 'siberdeyz_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

const loginFailures = new Map();

function now() {
  return Date.now();
}

function getClientKey(req) {
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || 'unknown';
}

function getFailureRecord(req) {
  const key = getClientKey(req);
  const current = loginFailures.get(key);
  const timestamp = now();

  if (!current || timestamp - current.windowStartedAt >= LOGIN_WINDOW_MS) {
    const fresh = { key, count: 0, windowStartedAt: timestamp };
    loginFailures.set(key, fresh);
    return fresh;
  }

  return { key, ...current };
}

function saveFailure(record) {
  loginFailures.set(record.key, {
    count: record.count,
    windowStartedAt: record.windowStartedAt,
  });
}

function clearFailures(req) {
  loginFailures.delete(getClientKey(req));
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));

  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, Buffer.alloc(leftBuffer.length));
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getSigningSecret() {
  return String(config.sessionSecret || config.adminPassword || '');
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function sign(value) {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(value)
    .digest('base64url');
}

function createToken() {
  const issuedAt = now();
  const encoded = encodePayload({
    iat: issuedAt,
    exp: issuedAt + SESSION_TTL_MS,
    nonce: crypto.randomBytes(18).toString('hex'),
  });

  return encoded + '.' + sign(encoded);
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!key) continue;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

function verifyToken(token) {
  if (!token || !getSigningSecret()) return false;

  const [encoded, signature, extra] = String(token).split('.');
  if (!encoded || !signature || extra) return false;

  const expected = sign(encoded);
  if (!safeEqual(signature, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    const expiresAt = Number(payload?.exp);
    return Number.isFinite(expiresAt) && expiresAt > now();
  } catch {
    return false;
  }
}

function cookieOptions(req) {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const secure = config.nodeEnv === 'production' || forwardedProto === 'https';

  return {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
  };
}

export function hasAdminSession(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return verifyToken(token);
}

export function loginAdmin(req, res) {
  if (!config.adminPassword) {
    res.status(503).json({ error: 'Admin girisi yapilandirilmamis.' });
    return;
  }

  const failure = getFailureRecord(req);
  if (failure.count >= LOGIN_MAX_FAILURES) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((failure.windowStartedAt + LOGIN_WINDOW_MS - now()) / 1000)
    );

    res.setHeader('retry-after', String(retryAfterSeconds));
    res.status(429).json({ error: 'Cok fazla hatali giris denemesi. Bir sure sonra tekrar deneyin.' });
    return;
  }

  if (!safeEqual(req.body?.adminPassword, config.adminPassword)) {
    failure.count += 1;
    saveFailure(failure);
    res.status(401).json({ error: 'Admin sifresi hatali.' });
    return;
  }

  clearFailures(req);
  res.cookie(COOKIE_NAME, createToken(), cookieOptions(req));
  res.setHeader('cache-control', 'no-store');
  res.json({ ok: true, authenticated: true });
}

export function logoutAdmin(req, res) {
  const options = cookieOptions(req);
  delete options.maxAge;

  res.clearCookie(COOKIE_NAME, options);
  res.setHeader('cache-control', 'no-store');
  res.json({ ok: true, authenticated: false });
}

export function getAdminSession(req, res) {
  res.setHeader('cache-control', 'no-store');
  res.json({ authenticated: hasAdminSession(req) });
}

export function requireAdminSession(req, res, next) {
  if (!hasAdminSession(req)) {
    res.setHeader('cache-control', 'no-store');
    res.status(401).json({ error: 'Oturum gerekli.' });
    return;
  }

  next();
}
