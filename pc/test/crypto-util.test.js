'use strict';

/**
 * Unit tests: Token comparison, Token minting, fingerprints, text truncation.
 * These cover the "constant-time comparison" requirement — both the behaviour
 * and the fact that length differences do not leak through an exception.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  constantTimeEquals,
  mintToken,
  sha256Hex,
  fingerprintOf,
  truncateUtf8,
  TOKEN_BYTES,
} = require('../src/crypto-util');

test('mintToken produces 32 random bytes as unpadded base64url', () => {
  const token = mintToken();
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'must be base64url with no padding');
  assert.equal(token.length, 43, '32 bytes base64url is 43 characters');
  assert.equal(Buffer.from(token, 'base64url').length, TOKEN_BYTES);
});

test('mintToken never repeats', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(mintToken());
  assert.equal(seen.size, 500);
});

test('constantTimeEquals accepts identical secrets', () => {
  const token = mintToken();
  assert.equal(constantTimeEquals(token, token), true);
  assert.equal(constantTimeEquals(Buffer.from(token), token), true);
});

test('constantTimeEquals rejects different secrets of equal length', () => {
  const a = 'a'.repeat(43);
  const b = 'b'.repeat(43);
  assert.equal(constantTimeEquals(a, b), false);
});

test('constantTimeEquals rejects secrets of different lengths without throwing', () => {
  // timingSafeEqual throws on mismatched lengths; the wrapper must not.
  assert.equal(constantTimeEquals('short', 'a-much-longer-secret'), false);
  assert.equal(constantTimeEquals('a-much-longer-secret', 'short'), false);
});

test('constantTimeEquals rejects empty and non-string input', () => {
  assert.equal(constantTimeEquals('', ''), false);
  assert.equal(constantTimeEquals(null, 'token'), false);
  assert.equal(constantTimeEquals('token', null), false);
  assert.equal(constantTimeEquals(undefined, undefined), false);
  assert.equal(constantTimeEquals(42, 'token'), false);
  assert.equal(constantTimeEquals({}, 'token'), false);
});

test('fingerprintOf is the first 16 hex chars of SHA-256(token)', () => {
  const token = mintToken();
  const fp = fingerprintOf(token);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, sha256Hex(token).slice(0, 16));
});

test('sha256Hex is lowercase hex of the exact bytes', () => {
  assert.equal(
    sha256Hex(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('truncateUtf8 leaves short text untouched', () => {
  const result = truncateUtf8('hello', 64);
  assert.deepEqual(result, { text: 'hello', truncated: false, bytes: 5 });
});

test('truncateUtf8 never splits a multi-byte code point', () => {
  // Each CJK character is 3 UTF-8 bytes: 10 chars = 30 bytes.
  const text = '一二三四五六七八九十';
  assert.equal(Buffer.byteLength(text, 'utf8'), 30);

  for (let limit = 1; limit <= 30; limit += 1) {
    const result = truncateUtf8(text, limit);
    assert.equal(result.truncated, limit < 30, `limit ${limit} truncation flag`);
    // The truncated text must be valid UTF-8 with no replacement characters.
    assert.ok(!result.text.includes('\uFFFD'), `limit ${limit} produced a replacement char`);
    assert.ok(result.bytes <= limit, `limit ${limit} produced ${result.bytes} bytes`);
    assert.equal(result.bytes, Buffer.byteLength(result.text, 'utf8'));
    // And it must be a prefix of the original.
    assert.ok(text.startsWith(result.text), `limit ${limit} is not a prefix`);
    // Exactly one code point per whole 3-byte step.
    assert.equal(result.text.length, Math.floor(limit / 3));
  }
});

test('truncateUtf8 does not corrupt text that legitimately contains U+FFFD', () => {
  // A naive "look for the replacement character" loop would eat this.
  const text = 'a\uFFFDb';
  assert.equal(Buffer.byteLength(text, 'utf8'), 5);
  const result = truncateUtf8(text, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.text, 'a\uFFFDb');
});

test('truncateUtf8 handles astral characters (emoji) atomically', () => {
  const text = '😀😀😀'; // 4 bytes each
  const result = truncateUtf8(text, 6);
  assert.equal(result.truncated, true);
  assert.equal(result.text, '😀');
  assert.equal(result.bytes, 4);
});

test('truncateUtf8 returns empty text when the limit is below one code point', () => {
  const result = truncateUtf8('😀', 2);
  assert.equal(result.text, '');
  assert.equal(result.truncated, true);
  assert.equal(result.bytes, 0);
});
