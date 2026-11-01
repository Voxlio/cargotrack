'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseEnv } = require('../lib/env.js');

/**
 * parseEnv deliberately returns a null-prototype object, so a key like
 * `__proto__` in a .env file cannot pollute Object.prototype. Spread before
 * deep-comparing against a literal, since assert compares prototypes too.
 */
const plain = (source) => ({ ...parseEnv(source) });

test('parseEnv reads plain key=value pairs', () => {
  assert.deepEqual(plain('ADMIN_USERNAME=admin\nADMIN_PASSWORD=hunter2'), {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'hunter2',
  });
});

test('parseEnv ignores comments, blank lines and malformed rows', () => {
  assert.deepEqual(plain(['# a comment', '', '   ', 'NO_EQUALS_HERE', 'VALID=1'].join('\n')), { VALID: '1' });
});

test('parseEnv strips `export ` prefixes', () => {
  assert.deepEqual(plain('export TZ=Africa/Lagos'), { TZ: 'Africa/Lagos' });
});

test('parseEnv respects quoting and trailing comments', () => {
  const parsed = parseEnv(`A="hello world"\nB='single quoted'\nC="with # hash"\nD=plain # comment`);
  assert.equal(parsed.A, 'hello world');
  assert.equal(parsed.B, 'single quoted');
  assert.equal(parsed.C, 'with # hash');
  assert.equal(parsed.D, 'plain');
});

test('parseEnv unescapes newlines and quotes inside double quotes', () => {
  const parsed = parseEnv('PEM="line1\\nline2\\"quoted\\""');
  assert.equal(parsed.PEM, 'line1\nline2"quoted"');
});

test('parseEnv keeps values containing = signs', () => {
  assert.equal(parseEnv('TOKEN=abc=def==').TOKEN, 'abc=def==');
});

test('parseEnv handles a BOM and CRLF line endings', () => {
  assert.deepEqual(plain('﻿FIRST=1\r\nSECOND=2\r\n'), { FIRST: '1', SECOND: '2' });
});

test('parseEnv rejects keys that are not valid identifiers', () => {
  assert.deepEqual(plain('1BAD=no\nnot a key=no\nGOOD=yes'), { GOOD: 'yes' });
});

test('parseEnv returns an empty object for non-string input', () => {
  assert.deepEqual(plain(null), {});
  assert.deepEqual(plain(undefined), {});
});

test('parseEnv keeps a __proto__ key from polluting Object.prototype', () => {
  const parsed = parseEnv('__proto__=polluted');
  assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.__proto__, 'polluted');
});
