'use strict';

/**
 * Unit tests: Echo suppression (PROTOCOL.md §5.6).
 *
 * This is the hard invariant. "Violating it makes both devices overwrite each
 * other's clipboard in an infinite loop", so the tests assert both directions
 * and the expiry, not just the happy path.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { EchoGuard } = require('../src/echo-guard');
const { sha256Hex } = require('../src/crypto-util');

/**
 * @param {object} [options]
 */
function makeGuard(options = {}) {
  const clock = { now: 1_000_000 };
  const guard = new EchoGuard({
    capacity: options.capacity ?? 8,
    ttlMs: options.ttlMs ?? 120_000,
    now: () => clock.now,
  });
  return { guard, clock };
}

test('a text the Hub itself wrote is suppressed when it comes back inbound', () => {
  const { guard } = makeGuard();
  const text = 'copied on the phone, written to the PC clipboard';

  guard.recordLocalWrite(text);
  const verdict = guard.inspectInbound(text);

  assert.equal(verdict.drop, true, 'our own write must never be treated as a user copy');
  assert.equal(verdict.reason, 'local-write');
  assert.equal(verdict.hash, sha256Hex(text));
});

test('a bounce of what the Hub sent to the Phone is suppressed', () => {
  const { guard } = makeGuard();
  const text = 'copied on the PC';

  guard.recordRemoteSend(text);
  const verdict = guard.inspectInbound(text);

  assert.equal(verdict.drop, true);
  assert.equal(verdict.reason, 'remote-send');
});

test('genuinely new phone text is allowed through', () => {
  const { guard } = makeGuard();
  guard.recordLocalWrite('something else entirely');

  const verdict = guard.inspectInbound('a brand new clipboard value from the phone');
  assert.equal(verdict.drop, false);
  assert.equal(verdict.reason, null);
});

test('an empty clipboard is not mistaken for a write of an empty string', () => {
  const { guard } = makeGuard();
  // Nothing was ever written, so empty text is just empty text.
  assert.equal(guard.inspectInbound('').drop, false);
});

test('suppression expires after the TTL', () => {
  const { guard, clock } = makeGuard({ ttlMs: 1000 });
  const text = 'hello';
  guard.recordLocalWrite(text);

  clock.now += 999;
  assert.equal(guard.inspectInbound(text).drop, true, 'still suppressed just before the TTL');

  clock.now += 1;
  assert.equal(guard.inspectInbound(text).drop, false, 'no longer suppressed at the TTL');
});

test('several recent writes are all suppressed, not just the latest', () => {
  const { guard } = makeGuard({ capacity: 4 });
  const values = ['one', 'two', 'three', 'four'];
  for (const value of values) {
    guard.recordLocalWrite(value);
    // Each write must be recognisable afterwards: a user can copy twice quickly
    // and the second write must not un-suppress the first.
  }
  for (const value of values) {
    assert.equal(guard.inspectInbound(value).drop, true, `"${value}" must still be suppressed`);
  }
});

test('the ring forgets the oldest entry beyond its capacity', () => {
  const { guard } = makeGuard({ capacity: 3 });
  const values = ['a', 'b', 'c', 'd'];
  for (const value of values) guard.recordLocalWrite(value);

  assert.equal(guard.inspectInbound('a').drop, false, 'the oldest entry must have been evicted');
  assert.equal(guard.inspectInbound('b').drop, true);
  assert.equal(guard.inspectInbound('d').drop, true);
});

test('local writes and remote sends are tracked separately', () => {
  const { guard } = makeGuard();
  guard.recordLocalWrite('from the phone');
  guard.recordRemoteSend('from the pc');

  assert.equal(guard.wasLocalWrite(sha256Hex('from the phone')), true);
  assert.equal(guard.wasLocalWrite(sha256Hex('from the pc')), false);

  const stats = guard.stats();
  assert.equal(stats.localWrites, 1);
  assert.equal(stats.remoteSends, 1);
});

test('the same text is suppressed in both directions, preventing an oscillation', () => {
  const { guard } = makeGuard();
  const text = 'identical on both sides';

  // Round 1: the phone sends it, the Hub writes it locally.
  assert.equal(guard.inspectInbound(text).drop, false);
  guard.recordLocalWrite(text);

  // Round 2: the helper echoes the local write back to the Hub, which would
  // send it to the phone; the phone bounces it. Both must be caught.
  guard.recordRemoteSend(text);
  assert.equal(guard.inspectInbound(text).drop, true);

  // Round 3: a new, unrelated value still flows.
  assert.equal(guard.inspectInbound('different').drop, false);
});

test('the suppressed counter only counts actual suppressions', () => {
  const { guard } = makeGuard();
  guard.recordLocalWrite('x');
  guard.inspectInbound('x');
  guard.inspectInbound('x');
  guard.inspectInbound('y');

  assert.equal(guard.stats().suppressed, 2);
});

test('suppression is by exact content, not by prefix or length', () => {
  const { guard } = makeGuard();
  guard.recordLocalWrite('hello world');

  assert.equal(guard.inspectInbound('hello world!').drop, false);
  assert.equal(guard.inspectInbound('hello worl').drop, false);
  assert.equal(guard.inspectInbound('hello world').drop, true);
});

test('hashing is UTF-8 exact for multi-byte content', () => {
  const { guard } = makeGuard();
  const text = '剪贴板同步 — clipboard sync 😀';
  guard.recordLocalWrite(text);

  assert.equal(guard.inspectInbound(text).drop, true);
  assert.equal(sha256Hex(text), sha256Hex(Buffer.from(text, 'utf8')));
});
