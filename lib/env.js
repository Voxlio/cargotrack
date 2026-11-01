/**
 * Minimal .env loader — deliberately dependency-free.
 *
 * Why not `dotenv`? Two reasons: this project only needs ~60 lines of parsing,
 * and a zero-dependency loader means `npm install` can fail entirely and the
 * server still starts.
 *
 * On Vercel, environment variables come from the dashboard and no .env file
 * exists; this loader silently does nothing there, which is correct.
 *
 * Supported syntax:
 *   KEY=value
 *   KEY="quoted value with spaces"
 *   KEY='single quoted'
 *   export KEY=value
 *   # comments, and blank lines
 *   VALUE="escaped \"quotes\" and \n newlines"
 *
 * Precedence: real environment variables always win over .env file values, so
 * Vercel/dashboard settings are never silently overridden by a committed file.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse .env file contents into a plain object. Pure function — no fs, no
 * process.env mutation — so it can be unit tested.
 *
 * @param {string} source raw file contents
 * @returns {Record<string, string>}
 */
function parseEnv(source) {
  const out = Object.create(null);
  if (typeof source !== 'string') return out;

  // Normalise BOM + CRLF (Windows editors).
  const text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Strip an optional `export ` prefix.
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;

    const eq = body.indexOf('=');
    if (eq === -1) continue;

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) continue;

    let value = body.slice(eq + 1).trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const close = value.lastIndexOf(quote);
      if (close > 0) {
        value = value.slice(1, close);
        if (quote === '"') {
          // Only double quotes get escape processing, matching dotenv/shell rules.
          value = value
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
        }
      }
    } else {
      // Unquoted: allow a trailing ` # comment`.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

/**
 * Load a .env file into process.env without clobbering existing variables.
 *
 * @param {string} [file] path to the env file
 * @returns {{ loaded: string[], file: string|null }}
 */
function loadEnv(file = path.join(__dirname, '..', '.env')) {
  const result = { loaded: [], file: null };

  if (!fs.existsSync(file)) return result;

  let parsed;
  try {
    parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[env] Could not read ${path.basename(file)}: ${err.message}`);
    return result;
  }

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      result.loaded.push(key);
    }
  }

  result.file = file;
  return result;
}

/**
 * Read a required setting, failing loudly with an actionable message.
 *
 * @param {string} key
 * @param {{ fallback?: string, description?: string }} [opts]
 * @returns {string}
 */
function requireEnv(key, opts = {}) {
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;

  if (opts.fallback !== undefined) return opts.fallback;

  const hint = opts.description ? ` (${opts.description})` : '';
  throw new Error(
    `Missing required environment variable ${key}${hint}.\n` +
      `  Locally: add it to .env (see .env.example).\n` +
      `  On Vercel: Project → Settings → Environment Variables.`
  );
}

module.exports = { parseEnv, loadEnv, requireEnv };
