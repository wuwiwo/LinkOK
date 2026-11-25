'use strict';

/**
 * Echo suppression (PROTOCOL.md §5.6) — a hard invariant.
 *
 * A clipboard write that LinkOK performed itself must never come back as if the
 * user had copied something. If it did, the Phone and the PC would keep
 * overwriting each other's clipboard forever.
 *
 * Two directions are tracked, because the Hub sits between them:
 *
 *  - `localWrite` : the Hub put this text on the PC clipboard (it came from the
 *    Phone). Any inbound Phone clipboard with that hash is the echo of our own
 *    write and is dropped.
 *  - `remoteSend`  : the Hub sent this text to the Phone. If the Phone bounces
 *    it back (its own echo guard failed, or it re-sent after a reconnect) the
 *    bounce is dropped instead of oscillating.
 *
 * Recent hashes are kept in a small ring so that two overlapping writes can
 * still be recognised, not just the very last one.
 */

const { sha256Hex } = require('./crypto-util');

const DEFAULT_CAPACITY = 8;
const DEFAULT_TTL_MS = 120_000;

class EchoGuard {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity] hashes remembered per direction
   * @param {number} [options.ttlMs] how long a remembered hash stays valid
   * @param {() => number} [options.now] epoch millis clock (injectable for tests)
   */
  constructor({ capacity = DEFAULT_CAPACITY, ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Array<{hash: string, at: number}>} */
    this.localWrites = [];
    /** @type {Array<{hash: string, at: number}>} */
    this.remoteSends = [];
    this.suppressed = 0;
  }

  /**
   * Scan a direction's ring for `hash`, pruning expired entries on the way.
   * O(capacity); capacity is 8.
   *
   * An entry is expired once `ttlMs` has elapsed: at exactly the TTL it no
   * longer suppresses, which keeps a stale hash from swallowing a genuine
   * clipboard value copied at the same content much later.
   *
   * @param {Array<{hash: string, at: number}>} list
   * @param {string} hash
   * @param {number} now
   * @returns {boolean}
   */
  _matches(list, hash, now) {
    let matched = false;
    const kept = [];
    for (const entry of list) {
      if (now - entry.at >= this.ttlMs) continue;
      kept.push(entry);
      if (entry.hash === hash) matched = true;
    }
    list.length = 0;
    list.push(...kept);
    return matched;
  }

  /**
   * @param {Array<{hash: string, at: number}>} list
   * @param {string} hash
   * @param {number} now
   */
  _remember(list, hash, now) {
    const kept = list.filter((entry) => now - entry.at < this.ttlMs);
    kept.push({ hash, at: now });
    while (kept.length > this.capacity) kept.shift();
    list.length = 0;
    list.push(...kept);
  }

  /**
   * Record that the Hub wrote `text` onto the PC clipboard.
   * @param {string} text
   * @returns {string} the hash, for logging
   */
  recordLocalWrite(text) {
    const hash = sha256Hex(text);
    this._remember(this.localWrites, hash, this.now());
    return hash;
  }

  /**
   * Record that the Hub sent `text` to the Phone.
   * @param {string} text
   * @returns {string} the hash
   */
  recordRemoteSend(text) {
    const hash = sha256Hex(text);
    this._remember(this.remoteSends, hash, this.now());
    return hash;
  }

  /**
   * Should an inbound clipboard text from the Phone be dropped?
   *
   * This is the invariant itself: yes when the Hub itself wrote that exact text
   * to the PC clipboard recently, or when it is the bounce of something the Hub
   * just sent to the Phone.
   *
   * @param {string} text
   * @returns {{drop: boolean, reason: 'local-write'|'remote-send'|null, hash: string}}
   */
  inspectInbound(text) {
    const hash = sha256Hex(text);
    const now = this.now();
    if (this._matches(this.localWrites, hash, now)) {
      this.suppressed += 1;
      return { drop: true, reason: 'local-write', hash };
    }
    if (this._matches(this.remoteSends, hash, now)) {
      this.suppressed += 1;
      return { drop: true, reason: 'remote-send', hash };
    }
    return { drop: false, reason: null, hash };
  }

  /**
   * True when `hash` is one of the values the Hub wrote to the PC clipboard.
   * Used by tests and diagnostics; `inspectInbound` is the hot path.
   * @param {string} hash
   * @returns {boolean}
   */
  wasLocalWrite(hash) {
    const now = this.now();
    return this._matches(this.localWrites, hash, now);
  }

  /** @returns {{localWrites: number, remoteSends: number, suppressed: number}} */
  stats() {
    return {
      localWrites: this.localWrites.length,
      remoteSends: this.remoteSends.length,
      suppressed: this.suppressed,
    };
  }
}

module.exports = { EchoGuard, DEFAULT_CAPACITY, DEFAULT_TTL_MS };
