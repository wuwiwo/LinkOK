'use strict';

/**
 * History: the PC-side archive of Captures that LinkOK itself wrote
 * (CONTEXT.md "History", PROTOCOL.md §8.1).
 *
 * Layout:
 *   <data>/history/index.json          {"version":1,"items":[HistoryItem]}
 *   <data>/history/2026-11-25/<id>.png
 *
 * Two invariants live here:
 *  - Retention only ever deletes files that this store created (paths come from
 *    the index and are containment-checked before any unlink).
 *  - Duplicate detection is by SHA-256 of the full image content: a Capture
 *    whose hash is already in History is dropped, never delivered twice.
 *
 * index.json is rewritten atomically (tmp -> fsync -> rename) after a short
 * debounce, so a burst of Captures costs one durable write, not N.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sha256Hex } = require('./crypto-util');
const { atomicWriteFile, atomicWriteJson, atomicWriteJsonSync, readJsonFileSync, quarantineFileSync } = require('./fs-atomic');
const { compactUtcId, isoWithOffset, localDateFolder, toDate } = require('./time');
const { tryReadPngSize } = require('./media');

/** index.json schema version. */
const INDEX_VERSION = 1;
/** Debounce window for index writes. */
const DEFAULT_FLUSH_DELAY_MS = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} HistoryItem
 * @property {string} id
 * @property {string} sha256
 * @property {'phone'|'pc-clipboard'|'pc-folder'} source
 * @property {string} arrivedAt
 * @property {string} file history-root-relative, forward slashes
 * @property {number} bytes
 * @property {number|null} width
 * @property {number|null} height
 */

const VALID_SOURCES = new Set(['phone', 'pc-clipboard', 'pc-folder']);

/**
 * @param {unknown} value
 * @returns {value is HistoryItem}
 */
function isHistoryItemLike(value) {
  if (value === null || typeof value !== 'object') return false;
  const item = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(item.sha256) &&
    typeof item.arrivedAt === 'string' &&
    typeof item.file === 'string' &&
    item.file.length > 0 &&
    typeof item.bytes === 'number'
  );
}

class HistoryStore {
  /**
   * @param {object} options
   * @param {string} options.dir history root
   * @param {import('./logger').Logger} options.logger
   * @param {() => Date} [options.now]
   * @param {number} [options.flushDelayMs]
   */
  constructor({ dir, logger, now = () => new Date(), flushDelayMs = DEFAULT_FLUSH_DELAY_MS }) {
    this.dir = path.resolve(dir);
    this.indexFile = path.join(this.dir, 'index.json');
    this.logger = logger;
    this.now = now;
    this.flushDelayMs = flushDelayMs;

    /** @type {Map<string, HistoryItem>} id -> item, insertion order = arrival order */
    this.items = new Map();
    /** @type {Map<string, string>} sha256 -> id, the dedup index */
    this.byHash = new Map();

    /** @type {NodeJS.Timeout|null} */
    this.flushTimer = null;
    this.dirty = false;
    this.closed = false;
    this.sweepTimer = null;
  }

  /**
   * Load index.json from disk. Missing files inside the index are pruned from
   * the index (with a warning) because History is LinkOK's own copy: an entry
   * whose PNG vanished is not presentable or re-sendable.
   *
   * @returns {number} number of items loaded
   */
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw;
    try {
      const read = readJsonFileSync(this.indexFile, null);
      if (!read.existed) {
        this.items = new Map();
        this.byHash = new Map();
        this.logger.info(`history index initialized at ${this.indexFile}`);
        return 0;
      }
      raw = read.value;
    } catch (err) {
      const backup = quarantineFileSync(this.indexFile);
      this.logger.error('history index is unreadable; starting empty', {
        error: /** @type {Error} */ (err).message,
        quarantined: backup,
      });
      this.items = new Map();
      this.byHash = new Map();
      this.dirty = true;
      this.scheduleFlush();
      return 0;
    }

    const list =
      raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).items)
        ? /** @type {unknown[]} */ (/** @type {any} */ (raw).items)
        : [];
    const items = new Map();
    const byHash = new Map();
    let dropped = 0;
    let missingFiles = 0;

    for (const candidate of list) {
      if (!isHistoryItemLike(candidate)) {
        dropped += 1;
        continue;
      }
      const item = {
        id: candidate.id,
        sha256: candidate.sha256,
        source: VALID_SOURCES.has(String(candidate.source))
          ? /** @type {HistoryItem['source']} */ (candidate.source)
          : 'phone',
        arrivedAt: candidate.arrivedAt,
        file: candidate.file,
        bytes: candidate.bytes,
        width: typeof candidate.width === 'number' ? candidate.width : null,
        height: typeof candidate.height === 'number' ? candidate.height : null,
      };
      const absolute = this.resolveFile(item);
      if (absolute === null || !fs.existsSync(absolute)) {
        missingFiles += 1;
        continue;
      }
      items.set(item.id, item);
      byHash.set(item.sha256, item.id);
    }

    this.items = items;
    this.byHash = byHash;
    if (dropped > 0 || missingFiles > 0) {
      this.logger.warn('history index repaired on load', { droppedInvalid: dropped, droppedMissingFile: missingFiles });
      this.dirty = true;
      this.scheduleFlush();
    }
    this.logger.info(`history loaded: ${items.size} item(s)`);
    return items.size;
  }

  /**
   * Absolute path of an item's PNG, or null when the relative path escapes the
   * history root. Never trust `item.file`: it is validated again here.
   * @param {Pick<HistoryItem, 'file'>} item
   * @returns {string|null}
   */
  resolveFile(item) {
    if (typeof item.file !== 'string' || item.file.length === 0) return null;
    const parts = item.file.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
    if (path.isAbsolute(item.file)) return null;
    const absolute = path.resolve(this.dir, ...parts);
    const rootWithSep = this.dir.endsWith(path.sep) ? this.dir : `${this.dir}${path.sep}`;
    if (!absolute.startsWith(rootWithSep)) return null;
    return absolute;
  }

  /**
   * @param {string} sha256
   * @returns {HistoryItem|null} the existing Capture with this content hash
   */
  findByHash(sha256) {
    const id = this.byHash.get(sha256.toLowerCase());
    if (!id) return null;
    return this.items.get(id) || null;
  }

  /**
   * Choose an id that is not taken.
   * @param {Date} arrivedAt
   * @param {string} sha256
   * @returns {string}
   */
  allocateId(arrivedAt, sha256) {
    const base = `${compactUtcId(arrivedAt)}-${sha256.slice(0, 6)}`;
    if (!this.items.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base}-${n}`;
      if (!this.items.has(candidate)) return candidate;
    }
    throw new Error(`cannot allocate a unique history id for ${base}`);
  }

  /**
   * Store a Capture as a date-foldered PNG and index it.
   *
   * The returned `duplicate` flag is the dedup verdict: when true nothing was
   * written and the returned item is the previously delivered one.
   *
   * `width`/`height` are read from the PNG's IHDR when the caller does not
   * supply them, so a caller cannot accidentally index a Capture with null
   * dimensions (the settings page renders them).
   *
   * @param {object} capture
   * @param {Buffer} capture.png PNG bytes
   * @param {'phone'|'pc-clipboard'|'pc-folder'} capture.source
   * @param {Date} [capture.arrivedAt]
   * @param {number|null} [capture.width]
   * @param {number|null} [capture.height]
   * @returns {Promise<{item: HistoryItem, duplicate: boolean}>}
   */
  async addCapture({ png, source, arrivedAt = this.now(), width = null, height = null }) {
    if (!Buffer.isBuffer(png)) {
      throw new TypeError('addCapture requires a Buffer of PNG bytes');
    }
    if (png.length === 0) {
      throw new Error('addCapture received an empty image');
    }
    if (!VALID_SOURCES.has(source)) {
      throw new Error(`addCapture received an unknown source: ${String(source)}`);
    }
    const sha256 = sha256Hex(png);
    const existing = this.findByHash(sha256);
    if (existing) {
      this.logger.info(`duplicate capture dropped (sha256 ${sha256.slice(0, 12)}…)`);
      return { item: existing, duplicate: true };
    }

    let dimensions = { width, height };
    if (typeof width !== 'number' || typeof height !== 'number') {
      const parsed = tryReadPngSize(png);
      dimensions = { width: parsed.width, height: parsed.height };
      if (dimensions.width === null) {
        this.logger.warn(`capture ${sha256.slice(0, 12)}… has no readable IHDR; dimensions unknown`);
      }
    }

    const when = toDate(arrivedAt, 'arrivedAt');
    const id = this.allocateId(when, sha256);
    const folder = localDateFolder(when);
    const relative = `${folder}/${id}.png`;
    const absolute = path.resolve(this.dir, folder, `${id}.png`);

    await atomicWriteFile(absolute, png);

    /** @type {HistoryItem} */
    const item = {
      id,
      sha256,
      source,
      arrivedAt: isoWithOffset(when),
      file: relative,
      bytes: png.length,
      width: dimensions.width,
      height: dimensions.height,
    };
    this.items.set(id, item);
    this.byHash.set(sha256, id);
    this.dirty = true;
    this.scheduleFlush();
    this.logger.info(`capture stored: ${relative} (${png.length} bytes, source ${source})`);
    return { item, duplicate: false };
  }

  /**
   * @param {object} [query]
   * @param {string|Date} [query.from] inclusive lower bound on arrivedAt
   * @param {string|Date} [query.to] inclusive upper bound on arrivedAt
   * @param {number} [query.limit] newest-first truncation
   * @returns {HistoryItem[]} newest first
   */
  list({ from, to, limit } = {}) {
    const fromMs = from === undefined || from === null || from === '' ? null : toDate(from, 'from').getTime();
    const toMs = to === undefined || to === null || to === '' ? null : toDate(to, 'to').getTime();
    const items = [];
    for (const item of this.items.values()) {
      const ms = toDate(item.arrivedAt, 'arrivedAt').getTime();
      if (fromMs !== null && ms < fromMs) continue;
      if (toMs !== null && ms > toMs) continue;
      items.push(item);
    }
    items.sort((a, b) => toDate(b.arrivedAt, 'arrivedAt').getTime() - toDate(a.arrivedAt, 'arrivedAt').getTime());
    if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
      return items.slice(0, Math.floor(limit));
    }
    return items;
  }

  /**
   * @param {string} id
   * @returns {HistoryItem|null}
   */
  get(id) {
    return this.items.get(id) || null;
  }

  /** @returns {number} */
  count() {
    return this.items.size;
  }

  /**
   * Delete one Capture (user action from the settings page).
   * @param {string} id
   * @returns {Promise<boolean>} true when something was deleted
   */
  async remove(id) {
    const item = this.items.get(id);
    if (!item) return false;
    await this.deleteFileOf(item);
    this.items.delete(id);
    if (this.byHash.get(item.sha256) === id) this.byHash.delete(item.sha256);
    this.dirty = true;
    this.scheduleFlush();
    this.logger.info(`history item deleted: ${id}`);
    return true;
  }

  /**
   * @param {HistoryItem} item
   */
  async deleteFileOf(item) {
    const absolute = this.resolveFile(item);
    if (absolute === null) {
      this.logger.error(`refusing to delete a path outside the history root: ${item.file}`);
      return;
    }
    try {
      await fsp.unlink(absolute);
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') {
        this.logger.warn(`history file already gone: ${item.file}`);
        return;
      }
      throw err;
    }
  }

  /**
   * Retention sweep (PROTOCOL.md §10).
   *
   * `retentionDays: 0` means Never and performs no deletion at all. Otherwise
   * every Capture whose Arrival Time is strictly older than the cutoff is
   * deleted together with its PNG. Nothing outside the history root is touched.
   *
   * @param {number} retentionDays
   * @returns {Promise<{deleted: number, kept: number, skipped: boolean, cutoff: string|null}>}
   */
  async sweep(retentionDays) {
    if (retentionDays === 0) {
      this.logger.info('retention: Never, nothing deleted');
      return { deleted: 0, kept: this.items.size, skipped: true, cutoff: null };
    }
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
      throw new Error(`sweep received an invalid retentionDays: ${String(retentionDays)}`);
    }
    const now = this.now();
    const cutoffMs = now.getTime() - retentionDays * DAY_MS;
    const cutoff = isoWithOffset(new Date(cutoffMs));

    const expired = [];
    for (const item of this.items.values()) {
      const ms = toDate(item.arrivedAt, 'arrivedAt').getTime();
      // Strictly older: an item exactly at the cutoff survives this pass.
      if (ms < cutoffMs) expired.push(item);
    }

    let deleted = 0;
    for (const item of expired) {
      try {
        await this.deleteFileOf(item);
        this.items.delete(item.id);
        if (this.byHash.get(item.sha256) === item.id) this.byHash.delete(item.sha256);
        deleted += 1;
      } catch (err) {
        this.logger.error(`retention could not delete ${item.file}`, {
          error: /** @type {Error} */ (err).message,
        });
      }
    }

    if (deleted > 0) {
      this.dirty = true;
      this.scheduleFlush();
      this.logger.info(`retention: deleted ${deleted} capture(s) older than ${cutoff}`);
    } else {
      this.logger.debug(`retention: nothing older than ${cutoff}`);
    }
    return { deleted, kept: this.items.size, skipped: false, cutoff };
  }

  /** Schedule a debounced index write. */
  scheduleFlush() {
    if (this.closed) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      // Async on purpose: the rename retry must be able to yield so that a
      // reader holding the file open (another process, or this process's own
      // read) gets a chance to close its handle and let the replace succeed.
      this.flushAsync().catch((err) => {
        this.logger.error('deferred history index write failed', {
          error: /** @type {Error} */ (err).message,
        });
      });
    }, this.flushDelayMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /**
   * Write index.json now, atomically, without blocking the event loop.
   * @returns {Promise<boolean>} true when a write happened
   */
  async flushAsync() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return false;
    // Snapshot before the await: items added mid-write must not be lost, and
    // they will mark the store dirty again for the next flush.
    const items = Array.from(this.items.values());
    this.dirty = false;
    try {
      await atomicWriteJson(this.indexFile, { version: INDEX_VERSION, items });
    } catch (err) {
      this.dirty = true;
      throw err;
    }
    return true;
  }

  /**
   * Write index.json now, atomically and synchronously. Used on shutdown and on
   * the deferred-timer error path, where there is no event loop left to await
   * and losing the index would be worse than blocking for a few milliseconds.
   * @returns {boolean} true when a write happened
   */
  flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return false;
    const items = Array.from(this.items.values());
    atomicWriteJsonSync(this.indexFile, { version: INDEX_VERSION, items });
    this.dirty = false;
    return true;
  }

  /**
   * Start the hourly Retention sweeper (PROTOCOL.md §10).
   * @param {() => number} retentionDaysProvider
   * @param {number} [intervalMs]
   * @returns {void}
   */
  startSweeper(retentionDaysProvider, intervalMs = 60 * 60 * 1000) {
    if (this.sweepTimer) return;
    const run = async () => {
      let days;
      try {
        days = retentionDaysProvider();
      } catch (err) {
        this.logger.error('retention sweep could not read the retention setting', {
          error: /** @type {Error} */ (err).message,
        });
        return;
      }
      try {
        await this.sweep(days);
      } catch (err) {
        this.logger.error('retention sweep failed', { error: /** @type {Error} */ (err).message });
      }
    };
    this.sweepTimer = setInterval(() => {
      void run();
    }, intervalMs);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    // Startup pass, per PROTOCOL.md §10.
    void run();
  }

  /** Stop timers and flush pending index writes. */
  close() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) {
      // Final write is synchronous so it still happens during process exit.
      const items = Array.from(this.items.values());
      try {
        atomicWriteJsonSync(this.indexFile, { version: INDEX_VERSION, items });
        this.dirty = false;
      } catch (err) {
        this.logger.error('final history index write failed', {
          error: /** @type {Error} */ (err).message,
        });
      }
    }
    this.closed = true;
  }
}

module.exports = {
  HistoryStore,
  INDEX_VERSION,
  DEFAULT_FLUSH_DELAY_MS,
  VALID_SOURCES,
  isHistoryItemLike,
};
