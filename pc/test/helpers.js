'use strict';

/**
 * Shared test fixtures.
 *
 * Two things here are non-obvious and deliberate:
 *
 * 1. `makePng` builds a *structurally valid* PNG (signature, IHDR, IDAT, IEND
 *    with real CRC32s). The Hub reads the IHDR to fill width/height and the
 *    Windows clipboard would reject anything malformed, so a fake "PNG" that is
 *    just a magic-number prefix would not test the real code path.
 *
 * 2. `TempDir` allocates under `pc/.test-tmp`, never under %LOCALAPPDATA%: the
 *    sandbox denies writes outside the workspace, and a test suite that cannot
 *    write its own fixtures would have to be weakened to pass.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const TEST_TMP_ROOT = path.join(__dirname, '..', '.test-tmp');

/** CRC32 table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number}
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} type 4 ASCII characters
 * @param {Buffer} data
 * @returns {Buffer}
 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Build a valid PNG of the requested size whose pixel bytes depend on `seed`,
 * so two calls with different seeds have different SHA-256 values.
 *
 * @param {object} [options]
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @param {number} [options.seed]
 * @returns {Buffer} complete PNG bytes
 */
function makePng({ width = 8, height = 8, seed = 1 } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline is a filter byte followed by RGB triples.
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * rowBytes + 1 + x * 3;
      raw[offset] = (x * 7 + seed * 13) & 0xff;
      raw[offset + 1] = (y * 11 + seed * 29) & 0xff;
      raw[offset + 2] = (x + y + seed * 41) & 0xff;
    }
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A PNG padded (via a private ancillary chunk) to at least `bytes` bytes, used
 * to exercise the >1MB chunking path.
 * @param {number} bytes
 * @returns {Buffer}
 */
function makeLargePng(bytes = 1_400_000) {
  const base = makePng({ width: 64, height: 64, seed: 7 });
  const overhead = 12 + 4; // length + type + crc + at least one data byte
  if (base.length >= bytes) return base;
  const padding = Buffer.alloc(Math.max(1, bytes - base.length - overhead), 0x41);
  const chunk = pngChunk('pAdD', padding);
  return Buffer.concat([base.subarray(0, base.length - 12), chunk, base.subarray(base.length - 12)]);
}

/**
 * A fresh directory under `pc/.test-tmp`, removed on process exit.
 */
class TempDir {
  /** @param {string} [label] */
  constructor(label = 'case') {
    fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
    this.path = fs.mkdtempSync(path.join(TEST_TMP_ROOT, `${label}-`));
    createdDirs.push(this.path);
  }

  /** @param {...string} parts @returns {string} */
  join(...parts) {
    return path.join(this.path, ...parts);
  }

  rm() {
    fs.rmSync(this.path, { recursive: true, force: true });
  }
}

/** @type {string[]} */
const createdDirs = [];

process.on('exit', () => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory must never fail the suite.
    }
  }
});

/**
 * Wait for a predicate to become true, or fail with a useful message.
 * @param {() => boolean} predicate
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.what]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, { timeoutMs = 3000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { makePng, makeLargePng, crc32, pngChunk, TempDir, waitFor, sleep, TEST_TMP_ROOT, os };
