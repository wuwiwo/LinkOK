'use strict';

/**
 * Image inspection. The Hub never decodes pixels: it only needs the PNG
 * signature (PROTOCOL.md §9 requires PNG on the wire) and the IHDR dimensions
 * to fill `width`/`height` into a HistoryItem.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Above this a Capture is refused (SPEC D3 / PROTOCOL §9: 20MB). */
const MAX_CAPTURE_BYTES = 20 * 1024 * 1024;

/**
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function isPng(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}

/**
 * Name the real format of an image buffer.
 *
 * Why this exists: the Hub only accepts PNG (PROTOCOL §9), and the first real
 * failure was a phone sending JPEG because Android screenshots default to .jpg.
 * The log said "not a PNG", which tells nobody what to fix. Naming the actual
 * container turns a dead end into a diagnosis.
 *
 * @param {Buffer} bytes
 * @returns {string} a short format label, or 'unknown'
 */
function sniffImageFormat(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return 'unknown';
  if (isPng(bytes)) return 'png';

  // JPEG: SOI marker FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';

  // GIF87a / GIF89a
  if (bytes.toString('latin1', 0, 6) === 'GIF87a' || bytes.toString('latin1', 0, 6) === 'GIF89a') {
    return 'gif';
  }

  // WebP: RIFF....WEBP
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }

  // HEIF / AVIF: box size then 'ftyp'
  if (bytes.toString('latin1', 4, 8) === 'ftyp') {
    const brand = bytes.toString('latin1', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    return 'heif';
  }

  // BMP: 'BM'
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';

  return 'unknown';
}

/**
 * Read width/height from a PNG IHDR chunk.
 *
 * Throws for anything that is not a structurally valid PNG: a Capture that
 * cannot be opened by the Windows clipboard is not worth storing, and the Phone
 * would only find out much later.
 *
 * @param {Buffer} bytes
 * @returns {{width: number, height: number}}
 */
function readPngSize(bytes) {
  if (!isPng(bytes)) {
    throw new Error('not a PNG (bad signature)');
  }
  if (bytes.length < 33) {
    throw new Error('PNG is truncated before IHDR');
  }
  const chunkLength = bytes.readUInt32BE(8);
  const chunkType = bytes.toString('latin1', 12, 16);
  if (chunkType !== 'IHDR' || chunkLength < 13) {
    throw new Error(`PNG does not start with IHDR (found ${chunkType})`);
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error(`PNG has an empty frame (${width}x${height})`);
  }
  return { width, height };
}

/**
 * Best-effort size read: returns nulls instead of throwing. Used where the
 * image comes from the helper and failing the whole Capture over metadata
 * would be user-hostile.
 * @param {Buffer} bytes
 * @returns {{width: number|null, height: number|null}}
 */
function tryReadPngSize(bytes) {
  try {
    const { width, height } = readPngSize(bytes);
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}

/**
 * @param {number} bytes
 * @returns {boolean}
 */
function isWithinCaptureLimit(bytes) {
  return bytes > 0 && bytes <= MAX_CAPTURE_BYTES;
}

module.exports = {
  PNG_SIGNATURE,
  MAX_CAPTURE_BYTES,
  sniffImageFormat,
  isPng,
  readPngSize,
  tryReadPngSize,
  isWithinCaptureLimit,
};

