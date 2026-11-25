'use strict';

/**
 * Atomic file writes.
 *
 * PROTOCOL.md §8.1 requires `index.json` to be written as
 * `index.json.tmp` -> fsync -> rename, so a power cut can never leave a
 * truncated index behind. The same helper is used for `config.json`,
 * `device.json` and history PNGs, because a half-written PNG is just as bad.
 *
 * `rename` is atomic on NTFS when source and destination live on the same
 * volume, which is why the temp file is always created next to the target.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/** Errno codes a directory fsync can legitimately raise on Windows. */
const DIR_FSYNC_UNSUPPORTED = new Set(['EISDIR', 'EPERM', 'EACCES', 'EBADF', 'EINVAL', 'ENOTSUP']);

/**
 * Windows refuses to replace a file that another handle holds open without
 * FILE_SHARE_DELETE (an antivirus scanner, Explorer's preview pane, a reader
 * streaming index.json). The rename then fails with EPERM/EBUSY for a few
 * milliseconds. Retrying briefly turns that transient failure into a normal
 * write instead of a lost index update.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 10;

/**
 * Synchronous sleep, used only between rename retries.
 * @param {number} ms
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // If Atomics.wait is unavailable we retry immediately; still correct.
  }
}

/**
 * @param {string} tmp
 * @param {string} file
 */
function renameWithRetrySync(tmp, file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (!code || !RENAME_RETRY_CODES.has(code) || attempt >= RENAME_RETRY_ATTEMPTS) throw err;
      sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * @param {string} tmp
 * @param {string} file
 */
async function renameWithRetry(tmp, file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (!code || !RENAME_RETRY_CODES.has(code) || attempt >= RENAME_RETRY_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}

/**
 * fsync the containing directory so the rename itself is durable. On Windows
 * this is not supported (you cannot open a directory as a file), so the
 * specific "cannot fsync a directory" errnos are tolerated; anything else is a
 * real problem and is re-thrown.
 *
 * @param {string} dir
 * @returns {boolean} true when the directory was actually fsynced
 */
function fsyncDirBestEffort(dir) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code && DIR_FSYNC_UNSUPPORTED.has(code)) return false;
    throw err;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // close() failing here cannot lose data: the rename already happened.
      }
    }
  }
}

/**
 * @param {string} dir
 */
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Synchronous atomic write: tmp -> fsync -> rename.
 * @param {string} file target path
 * @param {string|Buffer} data
 */
function atomicWriteFileSync(file, data) {
  const dir = path.dirname(file);
  ensureDirSync(dir);
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetrySync(tmp, file);
  fsyncDirBestEffort(dir);
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function atomicWriteJsonSync(file, value) {
  atomicWriteFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Asynchronous variant for large payloads (history PNGs) so a 20MB write does
 * not block the event loop.
 * @param {string} file target path
 * @param {Buffer|string} data
 */
async function atomicWriteFile(file, data) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await renameWithRetry(tmp, file);
  fsyncDirBestEffort(dir);
}

/**
 * Asynchronous atomic JSON write. Preferred over the sync variant while the Hub
 * is running: the rename retry can then yield to the event loop, which is what
 * lets a concurrent reader release its handle on Windows.
 * @param {string} file
 * @param {unknown} value
 */
async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Read a JSON file, returning `fallback` when it does not exist.
 * Corruption is *not* swallowed: it is reported to the caller, which decides
 * whether to quarantine the file.
 *
 * @param {string} file
 * @param {unknown} fallback
 * @returns {{value: unknown, existed: boolean}}
 */
function readJsonFileSync(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return { value: fallback, existed: false };
    }
    throw err;
  }
  return { value: JSON.parse(raw), existed: true };
}

/**
 * Move a damaged file aside instead of deleting it, so the user can inspect
 * what went wrong. Returns the backup path, or null when there was nothing.
 *
 * @param {string} file
 * @returns {string|null}
 */
function quarantineFileSync(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const target = `${file}.corrupt-${stamp}`;
  fs.renameSync(file, target);
  return target;
}

module.exports = {
  renameWithRetrySync,
  renameWithRetry,
  atomicWriteFileSync,
  atomicWriteJsonSync,
  atomicWriteFile,
  atomicWriteJson,
  ensureDirSync,
  readJsonFileSync,
  quarantineFileSync,
  fsyncDirBestEffort,
};
