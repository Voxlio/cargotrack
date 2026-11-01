/**
 * Loads server.js in an isolated environment:
 *   • express/cors resolve to local stubs (no npm access needed)
 *   • storage points at a throwaway database file
 *   • credentials and secrets are set deterministically
 *
 * Returns { app, dir, cleanup }.
 */

'use strict';

const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXPRESS_STUB = require.resolve('./express-stub.js');
const CORS_STUB = require.resolve('./cors-stub.js');

function installResolver() {
  if (Module.__cargotrackerPatched) return;
  Module.__cargotrackerPatched = true;

  const original = Module._resolveFilename;
  Module._resolveFilename = function patched(request, ...rest) {
    if (request === 'express') return EXPRESS_STUB;
    if (request === 'cors') return CORS_STUB;
    return original.call(this, request, ...rest);
  };
}

/**
 * @param {Record<string, string>} [overrides]
 */
function loadApp(overrides = {}) {
  installResolver();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargotracker-test-'));
  const dbFile = path.join(dir, 'database.json');
  fs.writeFileSync(dbFile, '{}');

  process.env.SHIPP_DB_FILE = dbFile;
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'test-password-1234';
  process.env.SESSION_SECRET = 'test-secret';
  // Empty (not deleted): lib/env.js only fills in *undefined* keys, so a real
  // .env on the developer's machine cannot switch these tests onto Redis.
  process.env.UPSTASH_REDIS_REST_URL = '';
  process.env.UPSTASH_REDIS_REST_TOKEN = '';
  process.env.VERCEL = '';

  Object.assign(process.env, overrides);

  // Fresh module graph each call so env changes take effect.
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}lib${path.sep}`) || key.endsWith('server.js')) {
      delete require.cache[key];
    }
  }

  // eslint-disable-next-line import/no-dynamic-require, global-require
  const app = require(path.join(__dirname, '..', '..', 'server.js'));

  return {
    app,
    dir,
    dbFile,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { loadApp };
