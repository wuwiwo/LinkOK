'use strict';

/**
 * Pairing and Token ownership.
 *
 * PROTOCOL.md §6.1:
 *  - the Pairing Code is 6 uppercase alphanumerics, valid for 120 s, single use;
 *  - 5 failed attempts lock further attempts for 5 minutes;
 *  - the QR payload is `linkok://pair?host=<ip>&port=<port>&code=<code>&fp=<fp>`.
 * PROTOCOL.md §2: the Token is 32 random bytes base64url, long-lived, and only
 * a new Pairing invalidates it.
 *
 * The Token never leaves the PC except through `POST /pair` and the
 * `Authorization` header, so it is stored in `device.json` (not `config.json`,
 * which the settings page can round-trip).
 */

const crypto = require('node:crypto');
const {
  constantTimeEquals,
  fingerprintOf,
  mintToken,
} = require('./crypto-util');
const { atomicWriteJsonSync, readJsonFileSync, quarantineFileSync } = require('./fs-atomic');
const { isoWithOffset } = require('./time');

/** Pairing Code lifetime (PROTOCOL.md §6.1). */
const PAIRING_CODE_TTL_MS = 120_000;
/** Failed attempts that trigger the lockout (PROTOCOL.md §6.1). */
const MAX_PAIRING_FAILURES = 5;
/** Lockout duration after too many failures (PROTOCOL.md §6.1). */
const PAIRING_LOCKOUT_MS = 5 * 60_000;
/** Alphanumeric alphabet, uppercase, no shell-hostile characters. */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PAIRING_CODE_LENGTH = 6;

/**
 * @typedef {object} DeviceRecord
 * @property {number} version
 * @property {string} instanceId stable random id for THIS Hub install
 * @property {string|null} token base64url Token, or null when not paired
 * @property {string|null} fingerprint SHA-256(token) first 16 hex chars
 * @property {string|null} deviceName
 * @property {string|null} deviceModel
 * @property {string|null} pairedAt ISO-8601 with offset
 */

/**
 * @typedef {object} ActivePairingCode
 * @property {string} code
 * @property {number} expiresAt epoch millis
 */

/** @returns {DeviceRecord} */
function emptyDevice() {
  return {
    version: 1,
    instanceId: crypto.randomBytes(8).toString('hex'),
    token: null,
    fingerprint: null,
    deviceName: null,
    deviceModel: null,
    pairedAt: null,
  };
}

/**
 * An unpaired device record that KEEPS an existing install id.
 *
 * `revoke()` must not mint a new `instanceId`: the id is how the Phone
 * recognises "this is still the same Hub" across revocations and network
 * changes, so regenerating it would make the Phone treat the PC as a different
 * machine the moment the user revokes a Token.
 *
 * @param {DeviceRecord} previous
 * @returns {DeviceRecord}
 */
function clearedDevice(previous) {
  return {
    version: 1,
    instanceId: previous.instanceId || crypto.randomBytes(8).toString('hex'),
    token: null,
    fingerprint: null,
    deviceName: null,
    deviceModel: null,
    pairedAt: null,
  };
}

/**
 * @param {number} [length]
 * @returns {string} uppercase alphanumeric code
 */
function generatePairingCode(length = PAIRING_CODE_LENGTH) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PAIRING_CODE_ALPHABET[crypto.randomInt(0, PAIRING_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string} normalised user-supplied code (uppercase, trimmed)
 */
function normalizeCode(value) {
  return String(value == null ? '' : value)
    .trim()
    .toUpperCase();
}

/**
 * Owns the single active Pairing Code, the lockout counter and the Token.
 */
class PairingService {
  /**
   * @param {object} options
   * @param {string} options.deviceFile
   * @param {import('./logger').Logger} options.logger
   * @param {() => Date} [options.now]
   * @param {() => string} [options.generateToken]
   */
  constructor({ deviceFile, logger, now = () => new Date(), generateToken = mintToken }) {
    this.deviceFile = deviceFile;
    this.logger = logger;
    this.now = now;
    this.generateToken = generateToken;

    /** @type {DeviceRecord} */
    this.device = emptyDevice();
    /** @type {ActivePairingCode|null} */
    this.active = null;
    this.failures = 0;
    this.lockedUntil = 0;
  }

  load() {
    try {
      const { value, existed } = readJsonFileSync(this.deviceFile, null);
      if (!existed) {
        // First run: mint the install id AND persist it immediately. Without
        // the write, every restart would produce a new identity and the Phone
        // would think it had found a different PC.
        this.device = emptyDevice();
        atomicWriteJsonSync(this.deviceFile, this.device);
        return this.device;
      }
      if (value === null || typeof value !== 'object') {
        throw new Error('device.json is not an object');
      }
      const raw = /** @type {Record<string, unknown>} */ (value);
      const token = typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : null;
      this.device = {
        version: 1,
        // Read the install id back. Without this every restart would mint a new
        // one, so an unpaired Hub would look like a different machine each time.
        instanceId:
          typeof raw.instanceId === 'string' && raw.instanceId !== ''
            ? raw.instanceId
            : crypto.randomBytes(8).toString('hex'),
        token,
        fingerprint: token ? fingerprintOf(token) : null,
        deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : null,
        deviceModel: typeof raw.deviceModel === 'string' ? raw.deviceModel : null,
        pairedAt: typeof raw.pairedAt === 'string' ? raw.pairedAt : null,
      };
      if (typeof raw.instanceId !== 'string' || raw.instanceId === '') {
        // An older device.json predates instanceId; persist the new one so the
        // fingerprint is stable from here on.
        atomicWriteJsonSync(this.deviceFile, this.device);
      }
      if (token) {
        this.logger.info(`paired device found: ${this.device.deviceName || 'unknown'}`);
      }
    } catch (err) {
      const backup = quarantineFileSync(this.deviceFile);
      this.logger.error('device.json is unreadable; treating the PC as unpaired', {
        error: /** @type {Error} */ (err).message,
        quarantined: backup,
      });
      this.device = emptyDevice();
    }
    return this.device;
  }

  /** @param {DeviceRecord} device */
  save(device) {
    this.device = device;
    atomicWriteJsonSync(this.deviceFile, device);
  }

  /** @returns {boolean} */
  isPaired() {
    return typeof this.device.token === 'string' && this.device.token.length > 0;
  }

  /** @returns {string|null} */
  get token() {
    return this.device.token;
  }

  /** @returns {string|null} */
  /**
   * Fingerprint of this Hub install.
   *
   * Before pairing there is no Token to hash, and `fingerprintOf('')` returns
   * the SHA-256 of the empty string — a constant shared by every unpaired Hub.
   * Two different machines would then answer each other's UDP discovery probes.
   * So the unpaired case falls back to a per-install `instanceId`, which is
   * persisted in device.json and is unique.
   *
   * @returns {string|null}
   */
  get fingerprint() {
    if (this.device.fingerprint) return this.device.fingerprint;
    return this.device.instanceId || null;
  }

  /** @returns {string|null} */
  get deviceName() {
    return this.device.deviceName;
  }

  /** @returns {boolean} */
  isLockedOut() {
    return this.now().getTime() < this.lockedUntil;
  }

  /** @returns {number} epoch millis when the lockout ends (0 when unlocked) */
  lockoutEndsAt() {
    return this.isLockedOut() ? this.lockedUntil : 0;
  }

  /**
   * Mint a new Pairing Code, replacing any previous one.
   * @returns {ActivePairingCode}
   */
  mintCode() {
    const code = generatePairingCode();
    const expiresAt = this.now().getTime() + PAIRING_CODE_TTL_MS;
    this.active = { code, expiresAt };
    this.logger.info('pairing code minted', { expiresAt: new Date(expiresAt).toISOString() });
    return this.active;
  }

  /** @returns {ActivePairingCode|null} the live code, or null when none is active */
  currentCode() {
    if (!this.active) return null;
    if (this.now().getTime() >= this.active.expiresAt) {
      this.active = null;
      return null;
    }
    return this.active;
  }

  /**
   * Build the QR payload (PROTOCOL.md §6.1).
   * @param {string} host LAN address reachable from the Phone
   * @param {number} port
   * @param {string} code
   * @returns {string}
   */
  qrPayload(host, port, code) {
    // Never fall back to fingerprintOf(''): that constant is identical on every
    // unpaired Hub, so discovery would match the wrong machine.
    const fp = this.fingerprint || this.device.instanceId || '';
    return `linkok://pair?host=${encodeURIComponent(host)}&port=${port}&code=${code}&fp=${fp}`;
  }

  /**
   * Check a Pairing Code and, when valid, mint a fresh Token.
   *
   * The order of checks matters: the lockout is evaluated before the code so a
   * locked-out attacker learns nothing from the response. A wrong code burns an
   * attempt; a successful attempt burns the code (single use).
   *
   * @param {unknown} suppliedCode
   * @param {{deviceName?: unknown, deviceModel?: unknown}} [meta]
   * @returns {{ok: true, token: string, device: DeviceRecord} | {ok: false, error: string, message: string}}
   */
  attemptPair(suppliedCode, meta = {}) {
    const now = this.now();
    if (this.isLockedOut()) {
      const seconds = Math.ceil((this.lockedUntil - now.getTime()) / 1000);
      return {
        ok: false,
        error: 'locked',
        message: `配对尝试过于频繁，请 ${seconds} 秒后再试`,
      };
    }

    const active = this.currentCode();
    const normalized = normalizeCode(suppliedCode);
    if (!active) {
      // No live code is not a credential failure; do not count it as one.
      return { ok: false, error: 'no_active_code', message: '配对码已过期，请在电脑上重新生成' };
    }

    if (!constantTimeEquals(normalized, active.code)) {
      this.failures += 1;
      this.logger.warn(`pairing code mismatch (${this.failures}/${MAX_PAIRING_FAILURES})`);
      if (this.failures >= MAX_PAIRING_FAILURES) {
        this.lockedUntil = now.getTime() + PAIRING_LOCKOUT_MS;
        this.failures = 0;
        this.active = null;
        this.logger.error('pairing locked out for 5 minutes after repeated failures');
        return {
          ok: false,
          error: 'locked',
          message: '配对失败次数过多，已锁定 5 分钟',
        };
      }
      return { ok: false, error: 'invalid_code', message: '配对码不正确' };
    }

    // Success: burn the code, reset the counter, mint a new Token.
    this.active = null;
    this.failures = 0;
    this.lockedUntil = 0;
    const token = this.generateToken();
    const deviceName =
      typeof meta.deviceName === 'string' && meta.deviceName.trim() !== ''
        ? meta.deviceName.trim()
        : 'Phone';
    const deviceModel = typeof meta.deviceModel === 'string' ? meta.deviceModel.trim() : '';
    const device = {
      version: 1,
      // Carry the install id across the pairing so the Hub keeps the same
      // identity; only the Token and the bound Phone change.
      instanceId: this.device.instanceId || crypto.randomBytes(8).toString('hex'),
      token,
      fingerprint: fingerprintOf(token),
      deviceName,
      deviceModel,
      pairedAt: isoWithOffset(now),
    };
    this.save(device);
    this.logger.info(`paired with ${deviceName}${deviceModel ? ` (${deviceModel})` : ''}`);
    return { ok: true, token, device };
  }

  /**
   * Revoke the Token (`POST /api/device/revoke`). The Phone must Pair again.
   * @returns {{revoked: boolean}}
   */
  revoke() {
    const had = this.isPaired();
    // Keep the install id: revoking a Token must not make the Phone believe it
    // is talking to a different Hub.
    this.device = clearedDevice(this.device);
    atomicWriteJsonSync(this.deviceFile, this.device);
    if (had) this.logger.warn('token revoked; the Phone must pair again');
    return { revoked: had };
  }
}

module.exports = {
  PAIRING_CODE_TTL_MS,
  MAX_PAIRING_FAILURES,
  PAIRING_LOCKOUT_MS,
  PAIRING_CODE_ALPHABET,
  PairingService,
  generatePairingCode,
  normalizeCode,
  emptyDevice,
};
