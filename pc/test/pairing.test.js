'use strict';

/**
 * Unit tests: the Pairing Code lifecycle (PROTOCOL.md §6.1).
 *
 * Time is injected, so a 120 s TTL and a 5 minute lockout are asserted exactly
 * rather than waited for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { PairingService, PAIRING_CODE_TTL_MS, MAX_PAIRING_FAILURES, PAIRING_LOCKOUT_MS } = require('../src/pairing');
const { TempDir, sleep } = require('./helpers');

/**
 * @param {object} [options]
 */
function makeService(options = {}) {
  const dir = new TempDir('pairing');
  const clock = { now: new Date('2026-11-25T16:46:51.132+08:00') };
  const logger = {
    lines: /** @type {Array<{level: string, message: string}>} */ ([]),
    info(message) {
      this.lines.push({ level: 'info', message });
    },
    warn(message) {
      this.lines.push({ level: 'warn', message });
    },
    error(message) {
      this.lines.push({ level: 'error', message });
    },
    debug() {},
    child() {
      return this;
    },
  };
  const service = new PairingService({
    deviceFile: dir.join('device.json'),
    logger: /** @type {any} */ (logger),
    now: () => clock.now,
    generateToken: options.generateToken,
  });
  // Mirror real startup: the Hub always loads (and so persists a fresh
  // instanceId) before it can mint a code or pair.
  service.load();
  return { service, dir, clock, logger };
}

/**
 * @param {object} clock
 * @param {number} ms
 */
function advance(clock, ms) {
  clock.now = new Date(clock.now.getTime() + ms);
}

test('a minted code is 6 uppercase alphanumerics', () => {
  const { service } = makeService();
  const { code } = service.mintCode();
  assert.match(code, /^[A-Z0-9]{6}$/);
});

test('minted codes are distinct across 200 draws', () => {
  const { service } = makeService();
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(service.mintCode().code);
  assert.ok(seen.size > 190, `expected mostly-distinct codes, got ${seen.size}/200`);
});

test('a fresh code pairs successfully and returns a 32-byte base64url Token', () => {
  const { service, dir } = makeService();
  const { code } = service.mintCode();
  const result = service.attemptPair(code, { deviceName: 'Redmi K50', deviceModel: 'M2012K11AC' });

  assert.equal(result.ok, true);
  assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(service.isPaired(), true);
  assert.equal(service.deviceName, 'Redmi K50');

  const stored = JSON.parse(fs.readFileSync(dir.join('device.json'), 'utf8'));
  assert.equal(stored.token, result.token);
  assert.equal(stored.fingerprint, service.fingerprint);
});

test('the code is single use: the second attempt is rejected', () => {
  const { service } = makeService();
  const { code } = service.mintCode();
  assert.equal(service.attemptPair(code).ok, true);

  const second = service.attemptPair(code);
  assert.equal(second.ok, false);
  assert.equal(second.error, 'no_active_code');
});

test('a code expires exactly 120 seconds after it is minted', () => {
  const { service, clock } = makeService();
  const { code, expiresAt } = service.mintCode();
  assert.equal(expiresAt - clock.now.getTime(), PAIRING_CODE_TTL_MS);
  assert.equal(PAIRING_CODE_TTL_MS, 120_000);

  advance(clock, PAIRING_CODE_TTL_MS - 1);
  assert.equal(service.attemptPair(code).ok, true, 'still valid 1 ms before expiry');
});

test('a code rejected at exactly the TTL boundary', () => {
  const { service, clock } = makeService();
  const { code } = service.mintCode();
  advance(clock, PAIRING_CODE_TTL_MS);

  const result = service.attemptPair(code);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_active_code');
});

test('a wrong code burns an attempt and reports invalid_code', () => {
  const { service } = makeService();
  service.mintCode();
  const result = service.attemptPair('ZZZZZZ');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_code');
  assert.equal(service.isPaired(), false);
});

test('5 failures lock pairing for 5 minutes, even with a correct code', () => {
  const { service, clock } = makeService();
  const { code } = service.mintCode();

  for (let i = 0; i < MAX_PAIRING_FAILURES - 1; i += 1) {
    const attempt = service.attemptPair('WRONG1');
    assert.equal(attempt.error, 'invalid_code', `attempt ${i + 1}`);
  }

  // The fifth failure trips the lockout instead of reporting invalid_code.
  const fifth = service.attemptPair('WRONG1');
  assert.equal(fifth.ok, false);
  assert.equal(fifth.error, 'locked');
  assert.equal(service.isLockedOut(), true);

  // Even the correct code is refused while locked.
  const correctWhileLocked = service.attemptPair(code);
  assert.equal(correctWhileLocked.ok, false);
  assert.equal(correctWhileLocked.error, 'locked');

  // A new code does not bypass the lockout either.
  service.mintCode();
  const afterMint = service.attemptPair('WHATEV');
  assert.equal(afterMint.error, 'locked');

  // 1 ms before the lockout ends it is still locked…
  advance(clock, PAIRING_LOCKOUT_MS - 1);
  assert.equal(service.attemptPair('WHATEV').error, 'locked');

  // …and at the boundary it is released.
  advance(clock, 1);
  assert.equal(service.isLockedOut(), false);
  assert.equal(PAIRING_LOCKOUT_MS, 5 * 60_000);
});

test('a successful pairing resets the failure counter', () => {
  const { service } = makeService();
  service.mintCode();
  service.attemptPair('BADBAD');
  service.attemptPair('BADBAD');
  service.attemptPair('BADBAD');
  service.attemptPair('BADBAD');

  const fresh = service.mintCode();
  assert.equal(service.attemptPair(fresh.code).ok, true);

  // Four more failures must not trip the lockout, because the counter restarted.
  const next = service.mintCode();
  for (let i = 0; i < MAX_PAIRING_FAILURES - 1; i += 1) {
    assert.equal(service.attemptPair('NOPE00').error, 'invalid_code');
  }
  assert.equal(service.isLockedOut(), false);
  assert.equal(service.attemptPair(next.code).ok, true);
});

test('minting a new code invalidates the previous one', () => {
  const { service } = makeService();
  const first = service.mintCode();
  const second = service.mintCode();
  assert.notEqual(first.code, second.code);

  assert.equal(service.attemptPair(first.code).ok, false);
  assert.equal(service.attemptPair(second.code).ok, true);
});

test('code comparison is case-insensitive and trims whitespace', () => {
  const { service } = makeService();
  const { code } = service.mintCode();
  assert.equal(service.attemptPair(` ${code.toLowerCase()} `).ok, true);
});

test('a new pairing replaces the previous Token', () => {
  const { service } = makeService();
  const first = service.mintCode();
  const firstResult = service.attemptPair(first.code);
  const firstToken = firstResult.token;

  const second = service.mintCode();
  const secondResult = service.attemptPair(second.code);

  assert.notEqual(firstToken, secondResult.token);
  assert.equal(service.token, secondResult.token, 'the stored token must be the new one');
});

test('revoke clears the Token and persists an unpaired device', () => {
  const { service, dir } = makeService();
  const { code } = service.mintCode();
  service.attemptPair(code);
  assert.equal(service.isPaired(), true);

  const result = service.revoke();
  assert.equal(result.revoked, true);
  assert.equal(service.isPaired(), false);
  assert.equal(service.token, null);

  const stored = JSON.parse(fs.readFileSync(dir.join('device.json'), 'utf8'));
  assert.equal(stored.token, null);
  assert.equal(stored.fingerprint, null);
});

test('revoking when never paired reports revoked: false', () => {
  const { service } = makeService();
  assert.equal(service.revoke().revoked, false);
});

test('the device record round-trips through load()', () => {
  const { service, dir } = makeService();
  const { code } = service.mintCode();
  const { token } = service.attemptPair(code, { deviceName: 'Redmi K50', deviceModel: 'M2012K11AC' });

  const reopened = new PairingService({
    deviceFile: dir.join('device.json'),
    logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }),
  });
  reopened.load();

  assert.equal(reopened.isPaired(), true);
  assert.equal(reopened.token, token);
  assert.equal(reopened.deviceName, 'Redmi K50');
  assert.equal(reopened.fingerprint, service.fingerprint);
});

test('the QR payload has the documented shape', () => {
  const { service } = makeService();
  const { code } = service.mintCode();
  service.attemptPair(code);

  const payload = service.qrPayload('192.168.1.100', 8787, 'AB12CD');
  assert.match(payload, /^linkok:\/\/pair\?host=192\.168\.1\.100&port=8787&code=AB12CD&fp=[0-9a-f]{16}$/);
});

test('an existing device.json with a stale fingerprint is repaired on load', async () => {
  const dir = new TempDir('pairing-stale');
  fs.writeFileSync(
    dir.join('device.json'),
    JSON.stringify({ version: 1, token: 'not-the-right-fingerprint', deviceName: 'Phone' }),
  );

  const service = new PairingService({
    deviceFile: dir.join('device.json'),
    logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }),
  });
  service.load();

  assert.equal(service.isPaired(), true);
  // The fingerprint is always derived, never trusted from disk.
  assert.match(String(service.fingerprint), /^[0-9a-f]{16}$/);
  assert.notEqual(service.fingerprint, 'not-the-right-fingerprint');
});

test('nothing is cached between a stale code and a restart', async () => {
  const { service, dir, clock } = makeService();
  const { code } = service.mintCode();
  advance(clock, PAIRING_CODE_TTL_MS + 1);
  assert.equal(service.currentCode(), null);
  assert.ok(fs.existsSync(dir.path));
});

// ── Hub identity: the `fp` in the QR payload and in UDP discovery ───────────
//
// PROTOCOL §6.1/§6.2 use `fp` so the Phone can tell "is this the same Hub?".
// A wrong `fp` either makes the Phone refuse its own PC or, worse, accept a
// different machine's discovery answer.

test('IDENTITY: two unpaired Hubs must not share a fingerprint', () => {
  const a = makeService();
  const b = makeService();

  // The original bug: fingerprintOf('') is a constant, so every unpaired Hub
  // reported the same fp and could answer another machine's discovery probe.
  assert.notEqual(a.service.fingerprint, b.service.fingerprint);
  assert.ok(a.service.fingerprint && a.service.fingerprint.length > 0);
  assert.ok(b.service.fingerprint && b.service.fingerprint.length > 0);
});

test('IDENTITY: the unpaired fingerprint is stable across a restart', () => {
  const { service, dir } = makeService();
  const before = service.fingerprint;
  assert.ok(before);

  const reopened = new PairingService({
    deviceFile: dir.join('device.json'),
    logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }),
  });
  reopened.load();

  assert.equal(reopened.fingerprint, before, 'a restart must not change the Hub identity');
});

test('IDENTITY: the fingerprint survives pairing, revoke and restart', () => {
  const { service, dir } = makeService();
  const installId = service.fingerprint;

  const { code } = service.mintCode();
  service.attemptPair(code);
  // After pairing the fingerprint switches to the Token hash, which is expected;
  // the install id must still be preserved underneath.
  assert.notEqual(service.fingerprint, installId);
  assert.equal(service.device.instanceId, installId);

  service.revoke();
  assert.equal(service.fingerprint, installId, 'revoking must not mint a new install id');

  const reopened = new PairingService({
    deviceFile: dir.join('device.json'),
    logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }),
  });
  reopened.load();
  assert.equal(reopened.fingerprint, installId, 'the identity must survive the restart too');
});

test('IDENTITY: the QR payload embeds the live fingerprint', () => {
  const { service } = makeService();
  const payload = service.qrPayload('192.168.1.100', 8787, 'AB12CD');
  assert.ok(payload.includes(`fp=${service.fingerprint}`), 'the QR must carry this Hub\'s fp');
  assert.ok(!payload.includes('fp=<'), 'the fp must be substituted, never left as a placeholder');
});

test('IDENTITY: a device.json without an instanceId is upgraded on load', () => {
  const dir = new TempDir('pairing-legacy');
  const file = dir.join('device.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, token: null, deviceName: null }));

  const service = new PairingService({
    deviceFile: file,
    logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }),
  });
  service.load();

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(String(persisted.instanceId), /^[0-9a-f]{16}$/, 'the install id must be persisted');
  assert.equal(service.fingerprint, persisted.instanceId);

  // And a second load keeps that same id rather than minting another.
  const reopened = new PairingService({
    deviceFile: file,
    logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }),
  });
  reopened.load();
  assert.equal(reopened.fingerprint, persisted.instanceId);
});
