'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Load a fresh copy of store.js pointed at a throwaway database file. */
function freshStore(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargotracker-store-'));
  const dbFile = path.join(dir, 'database.json');
  fs.writeFileSync(dbFile, '{}');

  process.env.SHIPP_DB_FILE = dbFile;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  Object.assign(process.env, env);

  delete require.cache[require.resolve('../lib/store.js')];
  const store = require('../lib/store.js');

  return {
    store,
    dbFile,
    read: () => JSON.parse(fs.readFileSync(dbFile, 'utf8')),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/* --------------------------- id validation -------------------------- */

test('normalizeId accepts canonical tracking ids', () => {
  const { store, cleanup } = freshStore();
  try {
    assert.equal(store.normalizeId('SH-12345'), 'SH-12345');
    assert.equal(store.normalizeId('  sh-99210  '), 'SH-99210');
  } finally {
    cleanup();
  }
});

test('normalizeId rejects malformed and hostile ids', () => {
  const { store, cleanup } = freshStore();
  try {
    for (const bad of ['', 'SH-123', 'SH-123456', 'WB-12345', 'SH-1234a', '../etc/passwd', null, 42]) {
      assert.equal(store.normalizeId(bad), null, `should reject ${JSON.stringify(bad)}`);
    }
  } finally {
    cleanup();
  }
});

test('looking up prototype keys never returns Object internals', async () => {
  const { store, cleanup } = freshStore();
  try {
    // The original did `database[cargoId]` directly, so these returned
    // Object.prototype members instead of 404.
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(store.normalizeId(key), null);
      assert.equal(await store.getShipment(key), null);
    }
  } finally {
    cleanup();
  }
});

/* ---------------------------- file backend -------------------------- */

test('round-trips a shipment through the file backend', async () => {
  const { store, read, cleanup } = freshStore();
  try {
    assert.equal(store.backendName(), 'files');
    assert.equal(await store.getShipment('SH-10001'), null);

    await store.putShipment('SH-10001', { waybill: 'WB-1', status: 'Sorting Depot' });
    assert.deepEqual(await store.getShipment('SH-10001'), { waybill: 'WB-1', status: 'Sorting Depot' });
    assert.equal(await store.shipmentExists('SH-10001'), true);

    const all = await store.listShipments();
    assert.deepEqual(Object.keys(all), ['SH-10001']);

    assert.equal(await store.deleteShipment('SH-10001'), true);
    assert.equal(await store.deleteShipment('SH-10001'), false);
    assert.deepEqual(read(), {});
  } finally {
    cleanup();
  }
});

test('concurrent writes are serialised, not lost', async () => {
  const { store, read, cleanup } = freshStore();
  try {
    const writes = [];
    for (let i = 0; i < 25; i += 1) {
      writes.push(store.putShipment(`SH-${10000 + i}`, { n: i }));
    }
    await Promise.all(writes);

    const db = read();
    assert.equal(Object.keys(db).length, 25, 'a concurrent write was lost');
  } finally {
    cleanup();
  }
});

test('a corrupt database file raises a storage error rather than wiping data', async () => {
  const { store, dbFile, cleanup } = freshStore();
  try {
    fs.writeFileSync(dbFile, '{ this is not json ');
    await assert.rejects(() => store.listShipments(), /could not be read/i);
  } finally {
    cleanup();
  }
});

test('writing is refused on a read-only deployment', async () => {
  const { store, cleanup } = freshStore({ VERCEL: '1' });
  try {
    await assert.rejects(
      () => store.putShipment('SH-10002', { waybill: 'x' }),
      (err) => err.code === 'read_only_filesystem' && err.status === 503
    );
  } finally {
    delete process.env.VERCEL;
    cleanup();
  }
});

/* --------------------------- redis backend -------------------------- */

test('selects the redis backend when Upstash credentials are present', () => {
  const { store, cleanup } = freshStore({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'token',
  });
  try {
    assert.equal(store.backendName(), 'redis');
  } finally {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    cleanup();
  }
});

test('redis mode talks to /pipeline and unwraps results in order', async () => {
  const { store, cleanup } = freshStore({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'token',
  });

  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, auth: options.headers.Authorization });

    let result;
    const [command] = body[0];
    if (command === 'GET') {
      result = body.map(() => JSON.stringify({ waybill: 'WB-9', status: 'Delivered' }));
      global.fetch.lastBody = body;
    } else {
      result = body.map(() => 'OK');
    }

    return {
      ok: true,
      status: 200,
      json: async () => (Array.isArray(result[0]) ? result[0] : result).map((r) => ({ result: r })),
    };
  };

  try {
    const record = await store.getShipment('SH-10003');
    assert.equal(record.waybill, 'WB-9');

    assert.equal(calls[0].url, 'https://example.upstash.io/pipeline');
    assert.equal(calls[0].auth, 'Bearer token');
    assert.deepEqual(calls[0].body, [['GET', 'shipp:item:SH-10003']]);
  } finally {
    global.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    cleanup();
  }
});

test('a single-item listing still parses (regression: batch shape)', async () => {
  const { store, cleanup } = freshStore({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'token',
  });

  const originalFetch = global.fetch;
  let call = 0;

  global.fetch = async () => {
    call += 1;
    if (call === 1) {
      // SMEMBERS -> exactly one id, which used to come back unwrapped.
      return { ok: true, status: 200, json: async () => [{ result: ['SH-10004'] }] };
    }
    return { ok: true, status: 200, json: async () => [{ result: JSON.stringify({ waybill: 'WB-solo' }) }] };
  };

  try {
    const all = await store.listShipments();
    assert.deepEqual(Object.keys(all), ['SH-10004']);
    assert.equal(all['SH-10004'].waybill, 'WB-solo');
  } finally {
    global.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    cleanup();
  }
});

test('redis errors surface as StorageError with a 5xx status', async () => {
  const { store, cleanup } = freshStore({
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'token',
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => [{ error: 'WRONGTYPE' }] });

  try {
    await assert.rejects(
      () => store.getShipment('SH-10005'),
      (err) => err.name === 'StorageError' && /WRONGTYPE/.test(err.message)
    );
  } finally {
    global.fetch = originalFetch;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    cleanup();
  }
});
