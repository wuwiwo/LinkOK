'use strict';

/**
 * Hashing / token / text helpers shared by the Hub.
 *
 * Everything that touches a Token goes through this module so that constant-time
 * comparison is impossible to get wrong by accident (PROTOCOL.md §2).
 */

const crypto = require('node:crypto');

/** Length of a Token in bytes (PROTOCOL.md §2: 32 bytes, base64url encoded). */
const TOKEN_BYTES = 32;

/**
 * @param {Buffer|string} input
 * @returns {string} lowercase hex SHA-256
 */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Mint a Token: 32 random bytes, base64url, no padding. 43 characters.
 * @returns {string}
 */
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Constant-time comparison of two secrets.
 *
 * Both sides are hashed to a fixed 32-byte digest first: `timingSafeEqual`
 * throws on differing lengths, and comparing digests keeps the comparison
 * independent of the caller-supplied length. Comparing digests is as strong as
 * comparing the raw secrets (SHA-256 collision resistance), and it never leaks
 * a length prefix through timing.
 *
 * @param {string|Buffer|null|undefined} provided untrusted value
 * @param {string|Buffer|null|undefined} expected stored secret
 * @returns {boolean}
 */
function constantTimeEquals(provided, expected) {
  if (typeof provided !== 'string' && !Buffer.isBuffer(provided)) return false;
  if (typeof expected !== 'string' && !Buffer.isBuffer(expected)) return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Fingerprint shown in the QR payload and echoed by UDP discovery:
 * first 16 hex chars of SHA-256(Token) (PROTOCOL.md §6.1).
 * @param {string} token
 * @returns {string}
 */
function fingerprintOf(token) {
  return sha256Hex(token).slice(0, 16);
}

/**
 * Truncate a string so its UTF-8 encoding fits in `maxBytes`, never splitting a
 * code point. Truncation is silent for the caller but we report whether it
 * happened so the Clipboard Sync path can log the 64KB cap (PROTOCOL.md §7).
 *
 * The cut is found structurally: UTF-8 continuation bytes match `0b10xxxxxx`,
 * so walking back from the byte budget until the first excluded byte is a lead
 * byte lands exactly on a code-point boundary. (A "decode and look for U+FFFD"
 * check would mangle text that legitimately contains U+FFFD.)
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {{text: string, truncated: boolean, bytes: number}}
 */
function truncateUtf8(text, maxBytes) {
  const full = Buffer.from(text, 'utf8');
  if (full.length <= maxBytes) {
    return { text, truncated: false, bytes: full.length };
  }
  let end = Math.max(0, maxBytes);
  while (end > 0 && (full[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  const decoded = full.subarray(0, end).toString('utf8');
  return {
    text: decoded,
    truncated: true,
    bytes: Buffer.byteLength(decoded, 'utf8'),
  };
}

module.exports = {
  TOKEN_BYTES,
  sha256Hex,
  mintToken,
  constantTimeEquals,
  fingerprintOf,
  truncateUtf8,
};
