/**
 * CargoTracker — logistics & shipment tracking API.
 *
 * Runs two ways from the same code:
 *   • locally   — `npm start` boots Express on PORT (default 3000)
 *   • on Vercel — api/index.js imports this module and hands `app` to the
 *                 serverless runtime; `listen()` is skipped.
 *
 * Configuration lives in .env locally and in the Vercel dashboard in
 * production. See .env.example for every supported variable.
 *
 * Endpoints
 *   POST   /api/auth/login          staff sign-in -> signed session token
 *   GET    /api/auth/session        validate a token
 *   GET    /api/health              liveness + storage backend
 *   GET    /api/shipments           list all shipments            (staff)
 *   GET    /api/shipments/:id       public tracking lookup
 *   POST   /api/shipments/create    create a waybill              (staff)
 *   PUT    /api/shipments/:id/status update status                (staff)
 *   DELETE /api/shipments/:id       remove a waybill              (staff)
 */

'use strict';

const path = require('node:path');
const express = require('express');
const cors = require('cors');

// Environment must be loaded before anything that reads process.env at import.
const { loadEnv } = require('./lib/env');
loadEnv();

const auth = require('./lib/auth');
const store = require('./lib/store');
const {
  STATUSES,
  ValidationError,
  buildShipment,
  applyStatusChange,
  randomTrackingId,
} = require('./lib/shipments');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ *
 * Middleware
 * ------------------------------------------------------------------ */

app.disable('x-powered-by');
// Vercel terminates TLS upstream; this makes req.ip the real client address.
app.set('trust proxy', 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    // Same-origin deployment (the Vercel default) needs no CORS at all. When
    // the frontend lives on another domain, list it in ALLOWED_ORIGINS.
    // Auth uses bearer tokens rather than cookies, so a wildcard leaks nothing
    // on its own — but an explicit list is still the safer default.
    origin: allowedOrigins.length ? allowedOrigins : true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  })
);

app.use(express.json({ limit: '64kb' }));

// A few headers that cost nothing and close obvious gaps.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(
  express.static(PUBLIC_DIR, {
    extensions: ['html'], // /admin resolves to admin.html without a redirect
    setHeaders(res, filePath) {
      if (/[\\/]images[\\/]/.test(filePath)) {
        // Photos never change behind a given filename; cache them hard.
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

/** Wrap an async route so rejections reach the error handler. */
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Auth
 * ------------------------------------------------------------------ */

app.post(
  '/api/auth/login',
  route(async (req, res) => {
    const gate = auth.checkLoginRate(req.ip);
    if (!gate.allowed) {
      res.setHeader('Retry-After', String(gate.retryAfter));
      return res.status(429).json({
        success: false,
        error: 'Too many failed sign-in attempts. Try again in a few minutes.',
      });
    }

    if (!auth.isConfigured()) {
      return res.status(503).json({
        success: false,
        error:
          'Staff authentication is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD ' +
          'in your environment (see .env.example).',
      });
    }

    const { username, password } = req.body || {};

    if (!auth.verifyCredentials(username, password)) {
      auth.recordFailure(req.ip);
      // Deliberately vague: never hint whether the username or password was wrong.
      return res.status(401).json({ success: false, error: 'Invalid staff credentials' });
    }

    auth.clearAttempts(req.ip);
    const { token, expiresAt, ttl } = auth.issueToken(username.trim());

    return res.status(200).json({
      success: true,
      token,
      user: 'Operations Admin',
      expiresAt,
      expiresIn: ttl,
    });
  })
);

app.get('/api/auth/session', auth.requireAuth, (req, res) => {
  res.status(200).json({ success: true, user: req.staff.username });
});

/* ------------------------------------------------------------------ *
 * Shipments
 * ------------------------------------------------------------------ */

app.get(
  '/api/shipments',
  auth.requireAuth,
  route(async (req, res) => {
    const database = await store.listShipments();
    res.status(200).json(database);
  })
);

app.get(
  '/api/shipments/:id',
  route(async (req, res) => {
    const id = store.normalizeId(req.params.id);

    if (!id) {
      return res.status(400).json({
        error: 'Tracking identifiers must look like SH-12345.',
      });
    }

    const record = await store.getShipment(id);
    if (!record) {
      return res.status(404).json({
        error: 'Tracking identifier not recognized in active database manifests.',
      });
    }

    return res.status(200).json(record);
  })
);

app.post(
  '/api/shipments/create',
  auth.requireAuth,
  route(async (req, res) => {
    // Find a tracking id that is not already in use. The original generated a
    // random 5-digit id and wrote it unconditionally, so a collision silently
    // destroyed an existing shipment.
    let trackingId = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const candidate = randomTrackingId();
      if (!(await store.shipmentExists(candidate))) {
        trackingId = candidate;
        break;
      }
    }

    if (!trackingId) {
      return res.status(503).json({
        error: 'Could not allocate a unique tracking id. Please retry.',
      });
    }

    const record = buildShipment(req.body, { trackingId });
    await store.putShipment(trackingId, record);

    return res.status(201).json({ success: true, trackingID: trackingId, shipment: record });
  })
);

app.put(
  '/api/shipments/:id/status',
  auth.requireAuth,
  route(async (req, res) => {
    const id = store.normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid tracking identifier format.' });

    const existing = await store.getShipment(id);
    if (!existing) return res.status(404).json({ error: 'Target package not found.' });

    const updated = applyStatusChange(existing, req.body);
    await store.putShipment(id, updated);

    return res.status(200).json({ success: true, shipment: updated });
  })
);

app.delete(
  '/api/shipments/:id',
  auth.requireAuth,
  route(async (req, res) => {
    const id = store.normalizeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid tracking identifier format.' });

    const removed = await store.deleteShipment(id);
    if (!removed) return res.status(404).json({ error: 'Package record not found.' });

    return res.status(200).json({ success: true, message: `Waybill ${id} permanently removed.` });
  })
);

/* ------------------------------------------------------------------ *
 * Meta
 * ------------------------------------------------------------------ */

app.get(
  '/api/health',
  route(async (req, res) => {
    const storage = await store.health();
    res.status(storage.ok ? 200 : 503).json({
      ok: storage.ok,
      storage,
      auth: auth.isConfigured() ? 'configured' : 'missing',
      statuses: STATUSES,
      uptime: Math.round(process.uptime()),
    });
  })
);

// Convenience alias so the documented /admin URL keeps working locally.
// On Vercel, clean URLs serve public/admin.html directly.
app.get(/^\/admin\/?$/, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
  }
  return res.status(404).sendFile(path.join(PUBLIC_DIR, '404.html'), (err) => {
    if (err) res.status(404).type('text').send('Not found');
  });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;

  if (err instanceof ValidationError || err instanceof store.StorageError) {
    return res.status(status).json({ success: false, error: err.message, code: err.code });
  }

  // Malformed JSON surfaces here as a SyntaxError from express.json().
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Request body is not valid JSON.' });
  }

  console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err);
  return res.status(status).json({
    success: false,
    error: status >= 500 ? 'Internal server error.' : err.message,
  });
});

/* ------------------------------------------------------------------ *
 * Local server
 * ------------------------------------------------------------------ */

if (require.main === module) {
  app.listen(PORT, () => {
    const storage = store.backendName() === 'redis' ? 'Upstash Redis' : 'database.json (local file)';
    console.log(`\n===================================================`);
    console.log(` CARGOTRACKER LOGISTICS ACTIVE BACKEND RUNNING`);
    console.log(` Public site:  http://localhost:${PORT}`);
    console.log(` Staff console: http://localhost:${PORT}/admin`);
    console.log(` Storage:      ${storage}`);
    console.log(` Staff auth:   ${auth.isConfigured() ? 'configured' : 'NOT CONFIGURED — set ADMIN_PASSWORD in .env'}`);
    console.log(`===================================================\n`);
  });
}

module.exports = app;
