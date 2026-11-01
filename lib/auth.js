/**
 * Staff authentication: env-backed credentials + HMAC-signed session tokens.
 *
 * Replaces the original hardcoded `admin` / `password` check and its
 * "SECURE_STAFF_TOKEN_JWT_MOCK" constant. That mock token was accepted by
 * nothing and verified by nothing — anyone could open devtools, set
 * sessionStorage.staffToken, and the UI would render a logged-in dashboard.
 * Write endpoints now actually require a token this module signed.
 *
 * Tokens are stateless HMAC-SHA256 envelopes, which is all a single-service app
 * needs: no session table, works identically on Vercel's ephemeral instances.
 *
 *   v1.<base64url(payload)>.<base64url(hmac)>
 *   payload = {"sub":"admin","iat":1700000000,"exp":1700003600}
 */

'use strict';

const crypto = require('crypto');

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_HOURS = 8;

// Per-process key used only to make credential comparison constant-time.
// Random per boot: it never leaves memory and is not used for token signing.
const COMPARE_KEY = crypto.randomBytes(32);

let warnedAboutFallback = false;
let warnedAboutSecret = false;

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

/**
 * Resolve the configured staff credentials.
 *
 * In production a missing ADMIN_PASSWORD fails closed (returns null) rather
 * than silently falling back to a default everyone can guess.
 *
 * @returns {{ username: string, password: string } | null}
 */
function getCredentials() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;

  if (username && password) return { username, password };

  const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  if (isProduction) return null;

  // Local convenience only: lets `npm start` work on a fresh clone.
  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      '\n[auth] ADMIN_USERNAME / ADMIN_PASSWORD are not set — using the local\n' +
        '       development defaults (admin / password) because NODE_ENV is not\n' +
        '       "production". Copy .env.example to .env to set real ones.\n'
    );
  }
  return { username: 'admin', password: 'password' };
}

/** Constant-time string comparison, safe across differing lengths. */
function safeEqual(a, b) {
  const ha = crypto.createHmac('sha256', COMPARE_KEY).update(String(a)).digest();
  const hb = crypto.createHmac('sha256', COMPARE_KEY).update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Check a submitted username/password pair in constant time.
 *
 * @param {unknown} username
 * @param {unknown} password
 * @returns {boolean}
 */
function verifyCredentials(username, password) {
  const creds = getCredentials();
  if (!creds) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;

  // Compare both fields every time so timing does not reveal which one failed.
  const userOk = safeEqual(username.trim().toLowerCase(), creds.username.trim().toLowerCase());
  const passOk = safeEqual(password, creds.password);
  return userOk && passOk;
}

/** True when credentials are configured; used to return a helpful 503. */
function isConfigured() {
  return getCredentials() !== null;
}

/* ------------------------------------------------------------------ *
 * Token signing
 * ------------------------------------------------------------------ */

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Signing key. SESSION_SECRET is the right answer; falling back to a key
 * derived from ADMIN_PASSWORD keeps tokens valid across restarts (Vercel cold
 * starts would otherwise log everyone out constantly) at no security loss,
 * since both are secrets of the same deployment.
 */
function getSecret() {
  const explicit = process.env.SESSION_SECRET;
  if (explicit) return explicit;

  const creds = getCredentials();
  if (!warnedAboutSecret) {
    warnedAboutSecret = true;
    console.warn(
      '\n[auth] SESSION_SECRET is not set. Deriving one from ADMIN_PASSWORD so\n' +
        '       sessions survive restarts. Set SESSION_SECRET to a long random\n' +
        '       string in production.\n'
    );
  }
  return crypto.createHash('sha256').update(`cargotracker:${creds ? creds.password : 'unset'}`).digest('hex');
}

function tokenTtlSeconds() {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3600;
}

/**
 * Issue a signed session token for a staff user.
 *
 * @param {string} username
 * @param {number} [now] injectable clock, for tests
 * @returns {{ token: string, expiresAt: number, ttl: number }}
 */
function issueToken(username, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const ttl = tokenTtlSeconds();
  const exp = iat + ttl;

  const payload = base64url(JSON.stringify({ sub: username, iat, exp }));
  const sig = base64url(crypto.createHmac('sha256', getSecret()).update(`${TOKEN_VERSION}.${payload}`).digest());

  return { token: `${TOKEN_VERSION}.${payload}.${sig}`, expiresAt: exp, ttl };
}

/**
 * Validate a token's signature and expiry.
 *
 * @param {string} token
 * @param {number} [now] injectable clock, for tests
 * @returns {{ ok: true, username: string, exp: number } | { ok: false, reason: string }}
 */
function verifyToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };

  const [, payload, sig] = parts;
  const expected = base64url(
    crypto.createHmac('sha256', getSecret()).update(`${TOKEN_VERSION}.${payload}`).digest()
  );

  const gotBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (gotBuf.length !== expBuf.length || !crypto.timingSafeEqual(gotBuf, expBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims;
  try {
    claims = JSON.parse(fromBase64url(payload).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!claims || typeof claims.exp !== 'number' || typeof claims.sub !== 'string') {
    return { ok: false, reason: 'malformed' };
  }

  if (claims.exp * 1000 <= now) return { ok: false, reason: 'expired' };

  return { ok: true, username: claims.sub, exp: claims.exp };
}

/* ------------------------------------------------------------------ *
 * Express middleware
 * ------------------------------------------------------------------ */

/** Pull a bearer token out of the Authorization header. */
function readBearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Express middleware: 401 unless the request carries a valid staff token.
 */
function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      success: false,
      error:
        'Staff authentication is not configured on this deployment. ' +
        'Set ADMIN_USERNAME and ADMIN_PASSWORD in the environment.',
    });
  }

  const result = verifyToken(readBearer(req));
  if (!result.ok) {
    return res.status(401).json({
      success: false,
      error: result.reason === 'expired' ? 'Session expired. Please sign in again.' : 'Not authenticated.',
      reason: result.reason,
    });
  }

  req.staff = { username: result.username };
  return next();
}

/* ------------------------------------------------------------------ *
 * Login rate limiting
 * ------------------------------------------------------------------ */

const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

/**
 * Fixed-window failed-login limiter, keyed by client IP.
 *
 * In-memory, so on Vercel each instance counts independently — that is fine,
 * it only needs to slow down scripted guessing, not enforce a hard quota.
 *
 * @returns {{ allowed: boolean, retryAfter: number }}
 */
function checkLoginRate(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const entry = attempts.get(key);

  if (!entry || now - entry.first > WINDOW_MS) {
    attempts.set(key, { first: now, count: 0 });
    return { allowed: true, retryAfter: 0 };
  }

  if (entry.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfter: Math.ceil((entry.first + WINDOW_MS - now) / 1000) };
  }

  return { allowed: true, retryAfter: 0 };
}

/** Record a failed attempt. */
function recordFailure(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    attempts.set(key, { first: now, count: 1 });
  } else {
    entry.count += 1;
  }
}

/** Clear the counter after a successful login. */
function clearAttempts(ip) {
  attempts.delete(String(ip || 'unknown'));
}

module.exports = {
  getCredentials,
  isConfigured,
  verifyCredentials,
  issueToken,
  verifyToken,
  requireAuth,
  readBearer,
  checkLoginRate,
  recordFailure,
  clearAttempts,
  tokenTtlSeconds,
};
