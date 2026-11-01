'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const auth = require('../lib/auth.js');

function withEnv(vars, fn) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/* --------------------------- credentials --------------------------- */

test('accepts the configured username and password', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 's3cret!', NODE_ENV: 'test', VERCEL: undefined }, () => {
    assert.equal(auth.verifyCredentials('ops', 's3cret!'), true);
  });
});

test('username comparison is case-insensitive, password is not', () => {
  withEnv({ ADMIN_USERNAME: 'Ops', ADMIN_PASSWORD: 'CaseSensitive', NODE_ENV: 'test', VERCEL: undefined }, () => {
    assert.equal(auth.verifyCredentials('ops', 'CaseSensitive'), true);
    assert.equal(auth.verifyCredentials('OPS', 'casesensitive'), false);
  });
});

test('rejects the wrong password and the wrong username', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'right', NODE_ENV: 'test', VERCEL: undefined }, () => {
    assert.equal(auth.verifyCredentials('ops', 'wrong'), false);
    assert.equal(auth.verifyCredentials('someone-else', 'right'), false);
  });
});

test('rejects non-string credentials instead of coercing them', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'right', NODE_ENV: 'test', VERCEL: undefined }, () => {
    assert.equal(auth.verifyCredentials({ $ne: null }, 'right'), false);
    assert.equal(auth.verifyCredentials('ops', undefined), false);
    assert.equal(auth.verifyCredentials('ops', 12345), false);
  });
});

test('fails closed in production when no password is configured', () => {
  withEnv({ ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined, NODE_ENV: 'production' }, () => {
    assert.equal(auth.isConfigured(), false);
    assert.equal(auth.verifyCredentials('admin', 'password'), false);
  });
});

test('allows the documented local default only outside production', () => {
  withEnv({ ADMIN_USERNAME: undefined, ADMIN_PASSWORD: undefined, NODE_ENV: 'development', VERCEL: undefined }, () => {
    assert.equal(auth.isConfigured(), true);
    assert.equal(auth.verifyCredentials('admin', 'password'), true);
  });
});

/* ----------------------------- tokens ----------------------------- */

test('issues a token that verifies and carries the username', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'k', NODE_ENV: 'test' }, () => {
    const { token } = auth.issueToken('ops');
    const result = auth.verifyToken(token);
    assert.equal(result.ok, true);
    assert.equal(result.username, 'ops');
  });
});

test('rejects a token whose payload was tampered with', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'k', NODE_ENV: 'test' }, () => {
    const { token } = auth.issueToken('ops');
    const [version, payload, sig] = token.split('.');

    const forged = Buffer.from(JSON.stringify({ sub: 'hacker', iat: 0, exp: 9e9 })).toString('base64url');
    const result = auth.verifyToken(`${version}.${forged}.${sig}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'bad_signature');

    // Sanity: the original still works.
    assert.equal(auth.verifyToken(`${version}.${payload}.${sig}`).ok, true);
  });
});

test('rejects a token signed with a different secret', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'key-one', NODE_ENV: 'test' }, () => {
    const { token } = auth.issueToken('ops');

    const saved = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'key-two';
    try {
      const result = auth.verifyToken(token);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'bad_signature');
    } finally {
      process.env.SESSION_SECRET = saved;
    }
  });
});

test('rejects expired tokens', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'k', NODE_ENV: 'test' }, () => {
    const issuedAt = Date.now() - 10 * 3600 * 1000; // 10 hours ago
    const { token } = auth.issueToken('ops', issuedAt);
    const result = auth.verifyToken(token, Date.now());
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'expired');
  });
});

test('honours SESSION_TTL_HOURS', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'k', SESSION_TTL_HOURS: '2', NODE_ENV: 'test' }, () => {
    const { ttl } = auth.issueToken('ops');
    assert.equal(ttl, 2 * 3600);
  });
});

test('rejects malformed and empty tokens', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'k', NODE_ENV: 'test' }, () => {
    for (const bad of ['', 'nope', 'v1.only-two', 'v2.abc.def', null, undefined, 42]) {
      assert.equal(auth.verifyToken(bad).ok, false, `expected rejection for ${String(bad)}`);
    }
  });
});

test('the old mock token is not accepted', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', SESSION_SECRET: 'k', NODE_ENV: 'test' }, () => {
    assert.equal(auth.verifyToken('SECURE_STAFF_TOKEN_JWT_MOCK').ok, false);
  });
});

/* ------------------------- rate limiting ------------------------- */

test('locks an IP out after repeated failures and resets on success', () => {
  withEnv({ ADMIN_USERNAME: 'ops', ADMIN_PASSWORD: 'pw', NODE_ENV: 'test' }, () => {
    const ip = '203.0.113.99';
    for (let i = 0; i < 10; i += 1) {
      assert.equal(auth.checkLoginRate(ip).allowed, true);
      auth.recordFailure(ip);
    }
    const gate = auth.checkLoginRate(ip);
    assert.equal(gate.allowed, false);
    assert.ok(gate.retryAfter > 0);

    auth.clearAttempts(ip);
    assert.equal(auth.checkLoginRate(ip).allowed, true);
  });
});
