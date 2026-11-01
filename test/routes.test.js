'use strict';

/**
 * End-to-end route tests: real HTTP against the real Express app definition,
 * real auth, real storage — with only express/cors stubbed out because this
 * environment cannot install packages.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { loadApp } = require('./helpers/load-app.js');

let ctx;
let server;
let baseUrl;
let token;

test.before(async () => {
  ctx = loadApp();
  server = http.createServer(ctx.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  ctx.cleanup();
});

async function call(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (options.body && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(baseUrl + path, {
    ...options,
    headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });

  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

const auth = () => ({ authorization: `Bearer ${token}` });

/* ------------------------------ health ----------------------------- */

test('GET /api/health reports the storage backend', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.storage.backend, 'files');
  assert.equal(res.body.auth, 'configured');
});

/* ------------------------------- auth ------------------------------ */

test('POST /api/auth/login rejects a bad password', async () => {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'nope' },
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
});

test('POST /api/auth/login rejects the old default password', async () => {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'password' },
  });
  assert.equal(res.status, 401, 'the hardcoded admin/password must no longer work');
});

test('POST /api/auth/login issues a token for correct credentials', async () => {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'test-password-1234' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.token);
  assert.ok(res.body.expiresAt > Date.now() / 1000);

  token = res.body.token;
});

test('GET /api/auth/session validates the token', async () => {
  const good = await call('/api/auth/session', { headers: auth() });
  assert.equal(good.status, 200);

  const bad = await call('/api/auth/session', { headers: { authorization: 'Bearer SECURE_STAFF_TOKEN_JWT_MOCK' } });
  assert.equal(bad.status, 401, 'the old mock token must not authenticate');
});

/* ---------------------------- protection --------------------------- */

test('staff endpoints reject unauthenticated requests', async () => {
  const endpoints = [
    ['GET', '/api/shipments'],
    ['POST', '/api/shipments/create'],
    ['PUT', '/api/shipments/SH-10000/status'],
    ['DELETE', '/api/shipments/SH-10000'],
  ];

  for (const [method, path] of endpoints) {
    const res = await call(path, {
      method,
      body: method === 'GET' ? undefined : { status: 'Delivered' },
    });
    assert.equal(res.status, 401, `${method} ${path} was not protected`);
  }
});

/* ----------------------------- shipments --------------------------- */

let createdId;

test('POST /api/shipments/create creates a waybill', async () => {
  const res = await call('/api/shipments/create', {
    method: 'POST',
    headers: auth(),
    body: {
      shipper: 'Lux Logistics SA, Paris (CDG)',
      receiver: 'TechCorp Industries, New York (JFK)',
      service: 'Express Air Freight Priority',
      status: 'In Transit',
    },
  });

  assert.equal(res.status, 201);
  assert.match(res.body.trackingID, /^SH-\d{5}$/);
  assert.equal(res.body.shipment.status, 'In Transit');
  assert.equal(res.body.shipment.step, 3);
  assert.ok(res.body.shipment.timeline.length >= 3);

  createdId = res.body.trackingID;
});

test('POST /api/shipments/create validates required fields', async () => {
  const res = await call('/api/shipments/create', {
    method: 'POST',
    headers: auth(),
    body: { receiver: 'Only a receiver' },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /shipper/i);
});

test('POST /api/shipments/create rejects an unknown status', async () => {
  const res = await call('/api/shipments/create', {
    method: 'POST',
    headers: auth(),
    body: { shipper: 'A, B', receiver: 'C, D', status: 'Teleported' },
  });
  assert.equal(res.status, 400);
});

test('GET /api/shipments lists shipments for staff only', async () => {
  const authed = await call('/api/shipments', { headers: auth() });
  assert.equal(authed.status, 200);
  assert.ok(authed.body[createdId]);

  const anon = await call('/api/shipments');
  assert.equal(anon.status, 401);
});

test('GET /api/shipments/:id is public tracking', async () => {
  const res = await call(`/api/shipments/${createdId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.shipper, 'Lux Logistics SA, Paris (CDG)');
});

test('GET /api/shipments/:id is case-insensitive', async () => {
  const res = await call(`/api/shipments/${createdId.toLowerCase()}`);
  assert.equal(res.status, 200);
});

test('GET /api/shipments/:id rejects malformed ids with 400, unknown with 404', async () => {
  const malformed = await call('/api/shipments/not-an-id');
  assert.equal(malformed.status, 400);

  const unknown = await call('/api/shipments/SH-00001');
  assert.equal(unknown.status, 404);
});

test('PUT /api/shipments/:id/status updates the shipment', async () => {
  const res = await call(`/api/shipments/${createdId}/status`, {
    method: 'PUT',
    headers: auth(),
    body: { status: 'Delivered', location: 'Lagos Depot' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.shipment.status, 'Delivered');
  assert.equal(res.body.shipment.step, 4);
  assert.equal(res.body.shipment.location, 'Lagos Depot');
});

test('PUT /api/shipments/:id/status 404s for a missing shipment and 400s for a bad status', async () => {
  const missing = await call('/api/shipments/SH-00002/status', {
    method: 'PUT',
    headers: auth(),
    body: { status: 'Delivered' },
  });
  assert.equal(missing.status, 404);

  const bad = await call(`/api/shipments/${createdId}/status`, {
    method: 'PUT',
    headers: auth(),
    body: { status: 'Wormhole' },
  });
  assert.equal(bad.status, 400);
});

test('DELETE /api/shipments/:id removes it, and a second delete 404s', async () => {
  const first = await call(`/api/shipments/${createdId}`, { method: 'DELETE', headers: auth() });
  assert.equal(first.status, 200);

  const second = await call(`/api/shipments/${createdId}`, { method: 'DELETE', headers: auth() });
  assert.equal(second.status, 404);

  const lookup = await call(`/api/shipments/${createdId}`);
  assert.equal(lookup.status, 404);
});

/* ------------------------------ errors ----------------------------- */

test('unknown API routes return JSON 404, not HTML', async () => {
  const res = await call('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /No such endpoint/);
});

test('malformed JSON bodies return 400', async () => {
  const res = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"username": "admin", ',
  });
  assert.equal(res.status, 400);
});
