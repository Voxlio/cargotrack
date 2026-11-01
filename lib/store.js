/**
 * Shipment persistence with two interchangeable backends.
 *
 *   files  — database.json on disk. Used for local development, and for any
 *            environment where the filesystem is writable and long-lived.
 *   redis  — Upstash Redis over its REST API. Used in production, because
 *            Vercel's serverless filesystem is read-only apart from /tmp,
 *            and /tmp is wiped between invocations. A JSON file written there
 *            would appear to work in a single request and then vanish.
 *
 * Both backends expose the same async surface, so route handlers never branch.
 * Upstash is spoken to with the global fetch — no client library, no
 * dependency, and it works identically in a serverless function.
 */

'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

// SHIPP_DB_FILE lets the test suite point at a scratch file instead of the
// real database.json.
const DB_FILE = process.env.SHIPP_DB_FILE
  ? path.resolve(process.env.SHIPP_DB_FILE)
  : path.join(__dirname, '..', 'database.json');
const KEY_PREFIX = process.env.SHIPP_KEY_PREFIX || 'shipp:';
const INDEX_KEY = `${KEY_PREFIX}index`;
const REQUEST_TIMEOUT_MS = 8000;

/** Tracking IDs look like SH-99210. Anything else never reaches storage. */
const ID_PATTERN = /^SH-[0-9]{5}$/;

/** Error carrying an HTTP status, so routes can map it without guessing. */
class StorageError extends Error {
  constructor(message, status = 500, code = 'storage_error') {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
  }
}

/** True for keys that could reach Object.prototype through bracket lookup. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring']);

/**
 * Normalise and validate a tracking id.
 * @returns {string|null} canonical upper-case id, or null when invalid
 */
function normalizeId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toUpperCase();
  if (!ID_PATTERN.test(id)) return null;
  if (FORBIDDEN_KEYS.has(id.toLowerCase())) return null;
  return id;
}

/* ------------------------------------------------------------------ *
 * Upstash REST client
 * ------------------------------------------------------------------ */

function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/**
 * Run one or more Redis commands and return their results in order.
 *
 * Always uses Upstash's /pipeline endpoint, even for a single command, so the
 * return shape is a consistent array. (Sending a lone command to the base URL
 * returns a single unwrapped `{result}` instead, which is an easy way to write
 * code that works with two items and quietly breaks with one.)
 *
 * @param {Array<Array<string|number>>} commands
 * @returns {Promise<Array<unknown>>}
 */
async function upstash(commands) {
  const cfg = upstashConfig();
  if (!cfg) throw new StorageError('Redis backend is not configured.', 503, 'no_redis');

  let res;
  try {
    res = await fetch(`${cfg.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timed out' : err.message;
    throw new StorageError(`Redis request failed: ${reason}`, 503, 'redis_unreachable');
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw new StorageError(`Redis returned a non-JSON response (HTTP ${res.status}).`, 502, 'redis_bad_response');
  }

  if (!res.ok) {
    const detail = json?.error || `HTTP ${res.status}`;
    throw new StorageError(`Redis rejected the request: ${detail}`, 502, 'redis_error');
  }

  if (!Array.isArray(json)) {
    throw new StorageError('Redis returned an unexpected response shape.', 502, 'redis_bad_response');
  }

  const errored = json.find((r) => r && r.error);
  if (errored) throw new StorageError(`Redis error: ${errored.error}`, 502, 'redis_error');

  return json.map((r) => (r && 'result' in r ? r.result : null));
}

function itemKey(id) {
  return `${KEY_PREFIX}item:${id}`;
}

/* ------------------------------------------------------------------ *
 * File backend
 * ------------------------------------------------------------------ */

function isVercelLike() {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function readFileDb() {
  try {
    const raw = await fs.readFile(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('database.json does not contain a JSON object');
    }
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('[store] Could not read database.json:', err.message);
    throw new StorageError('The shipment database could not be read.', 500, 'db_unreadable');
  }
}

// Serialises read-modify-write cycles inside this process so two concurrent
// requests cannot interleave and lose an update.
let fileWriteChain = Promise.resolve();

async function writeFileDb(mutate) {
  const run = async () => {
    if (isVercelLike()) {
      throw new StorageError(
        'This deployment has no writable persistent storage. Connect Upstash Redis ' +
          '(set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN) to create or ' +
          'change shipments in production.',
        503,
        'read_only_filesystem'
      );
    }

    const db = await readFileDb();
    const result = await mutate(db);
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(db, null, 4), 'utf8');
      await fs.rename(tmp, DB_FILE); // atomic swap: a crash never leaves a half-written DB
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') {
        throw new StorageError(
          'The filesystem is read-only, so shipments cannot be saved here. ' +
            'Configure Upstash Redis for writable persistence.',
          503,
          'read_only_filesystem'
        );
      }
      throw new StorageError(`Could not save the shipment database: ${err.message}`, 500, 'db_write_failed');
    }
    return result;
  };

  const queued = fileWriteChain.then(run, run);
  // Keep the chain alive even if this caller's write rejects.
  fileWriteChain = queued.catch(() => {});
  return queued;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Which backend is active right now. */
function backendName() {
  return upstashConfig() ? 'redis' : 'files';
}

/**
 * All shipments, as `{ "SH-12345": record }`.
 * @returns {Promise<Record<string, object>>}
 */
async function listShipments() {
  if (backendName() === 'redis') {
    const [ids] = await upstash([['SMEMBERS', INDEX_KEY]]);
    if (!Array.isArray(ids) || ids.length === 0) return {};

    const results = await upstash(ids.map((id) => ['GET', itemKey(id)]));
    const out = {};
    ids.forEach((id, i) => {
      const raw = results[i];
      if (!raw) return;
      try {
        out[id] = JSON.parse(raw);
      } catch {
        console.error(`[store] Skipping corrupt record for ${id}`);
      }
    });
    return out;
  }

  return readFileDb();
}

/**
 * One shipment, or null when it does not exist.
 * @param {string} rawId
 * @returns {Promise<object|null>}
 */
async function getShipment(rawId) {
  const id = normalizeId(rawId);
  if (!id) return null;

  if (backendName() === 'redis') {
    const [raw] = await upstash([['GET', itemKey(id)]]);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      console.error(`[store] Corrupt record for ${id}`);
      return null;
    }
  }

  const db = await readFileDb();
  return Object.prototype.hasOwnProperty.call(db, id) ? db[id] : null;
}

/** True when the id is already taken (used to avoid overwriting on collision). */
async function shipmentExists(rawId) {
  return (await getShipment(rawId)) !== null;
}

/**
 * Insert or replace a shipment.
 * @param {string} rawId
 * @param {object} record
 */
async function putShipment(rawId, record) {
  const id = normalizeId(rawId);
  if (!id) throw new StorageError(`Invalid tracking id: ${rawId}`, 400, 'invalid_id');

  if (backendName() === 'redis') {
    await upstash([
      ['SET', itemKey(id), JSON.stringify(record)],
      ['SADD', INDEX_KEY, id],
    ]);
    return record;
  }

  await writeFileDb((db) => {
    db[id] = record;
  });
  return record;
}

/**
 * Delete a shipment.
 * @returns {Promise<boolean>} true when something was deleted
 */
async function deleteShipment(rawId) {
  const id = normalizeId(rawId);
  if (!id) return false;

  if (backendName() === 'redis') {
    const results = await upstash([
      ['DEL', itemKey(id)],
      ['SREM', INDEX_KEY, id],
    ]);
    return Number(results?.[0] || 0) > 0;
  }

  return writeFileDb((db) => {
    if (!Object.prototype.hasOwnProperty.call(db, id)) return false;
    delete db[id];
    return true;
  });
}

/** Cheap connectivity probe for /api/health. */
async function health() {
  const backend = backendName();
  if (backend === 'redis') {
    try {
      await upstash([['PING']]);
      return { backend, ok: true };
    } catch (err) {
      return { backend, ok: false, error: err.message };
    }
  }
  return { backend, ok: true };
}

module.exports = {
  StorageError,
  normalizeId,
  backendName,
  listShipments,
  getShipment,
  shipmentExists,
  putShipment,
  deleteShipment,
  health,
  DB_FILE,
  KEY_PREFIX,
};
