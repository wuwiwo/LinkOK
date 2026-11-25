'use strict';

/**
 * Chunked Capture reassembly (PROTOCOL.md §5.4).
 *
 *   {"type":"chunk","id":"…","seq":0,"total":3}
 *   <binary 256KB>
 *   {"type":"chunk","id":"…","seq":1,"total":3}
 *   <binary 256KB>
 *   …
 *
 * A transfer is serial per connection (PROTOCOL.md §12), so this class holds at
 * most one pending transfer. Any gap, duplicate `seq`, id mismatch or size
 * overflow aborts the whole Capture: the receiver must discard it rather than
 * hand a half-decoded PNG to the clipboard.
 */

class ChunkError extends Error {
  /**
   * @param {string} code machine-readable reason (sent as capture-result.reason)
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'ChunkError';
    this.code = code;
  }
}

class ChunkReassembler {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBytes] hard cap on one reassembled Capture (20MB + headroom)
   * @param {number} [options.maxChunks] hard cap on `total`
   */
  constructor({ maxBytes = 21 * 1024 * 1024, maxChunks = 512 } = {}) {
    this.maxBytes = maxBytes;
    this.maxChunks = maxChunks;
    /** @type {{id: string, total: number, nextSeq: number, chunks: Buffer[], bytes: number}|null} */
    this.pending = null;
  }

  /** @returns {boolean} */
  get inProgress() {
    return this.pending !== null;
  }

  /**
   * Announce the next chunk. Must be followed by exactly one binary frame.
   * @param {{id: unknown, seq: unknown, total: unknown}} meta
   * @returns {{id: string, seq: number, total: number}}
   */
  announce(meta) {
    if (meta === null || typeof meta !== 'object') {
      throw new ChunkError('malformed', 'chunk metadata is not an object');
    }
    const { id, seq, total } = /** @type {{id: unknown, seq: unknown, total: unknown}} */ (meta);
    if (typeof id !== 'string' || id.length === 0) {
      throw new ChunkError('malformed', 'chunk id is missing');
    }
    if (!Number.isInteger(seq) || /** @type {number} */ (seq) < 0) {
      throw new ChunkError('malformed', 'chunk seq must be a non-negative integer');
    }
    if (!Number.isInteger(total) || /** @type {number} */ (total) < 1) {
      throw new ChunkError('malformed', 'chunk total must be a positive integer');
    }
    const totalNumber = /** @type {number} */ (total);
    const seqNumber = /** @type {number} */ (seq);
    if (totalNumber > this.maxChunks) {
      throw new ChunkError('too_large', `chunk total ${totalNumber} exceeds the limit of ${this.maxChunks}`);
    }
    if (seqNumber >= totalNumber) {
      throw new ChunkError('malformed', `chunk seq ${seqNumber} is outside total ${totalNumber}`);
    }

    if (seqNumber === 0) {
      // A new transfer silently replaces any abandoned one; the previous
      // transfer is reported as incomplete by the caller via its own id.
      this.pending = { id, total: totalNumber, nextSeq: 0, chunks: [], bytes: 0 };
    }

    const pending = this.pending;
    if (!pending) {
      throw new ChunkError('incomplete', `chunk ${seqNumber} arrived without a seq 0`);
    }
    if (pending.id !== id) {
      throw new ChunkError('incomplete', `chunk id ${id} does not match the transfer in progress (${pending.id})`);
    }
    if (pending.total !== totalNumber) {
      throw new ChunkError('malformed', `chunk total changed mid-transfer (${pending.total} -> ${totalNumber})`);
    }
    if (seqNumber !== pending.nextSeq) {
      throw new ChunkError(
        'incomplete',
        `expected chunk ${pending.nextSeq} but received ${seqNumber}`,
      );
    }
    return { id, seq: seqNumber, total: totalNumber };
  }

  /**
   * Append the binary body for the chunk announced last.
   * @param {Buffer} data
   * @returns {{complete: false, id: string, received: number, total: number} | {complete: true, id: string, data: Buffer, total: number}}
   */
  push(data) {
    const pending = this.pending;
    if (!pending) {
      throw new ChunkError('malformed', 'binary frame arrived without a chunk announcement');
    }
    if (!Buffer.isBuffer(data)) {
      throw new ChunkError('malformed', 'chunk body is not a Buffer');
    }
    pending.bytes += data.length;
    if (pending.bytes > this.maxBytes) {
      const id = pending.id;
      this.pending = null;
      throw new ChunkError('too_large', `${id} exceeds the ${this.maxBytes}-byte limit`);
    }
    pending.chunks.push(data);
    pending.nextSeq += 1;

    if (pending.nextSeq === pending.total) {
      const { id, chunks } = pending;
      this.pending = null;
      return { complete: true, id, data: Buffer.concat(chunks, pending.bytes), total: pending.total };
    }
    return { complete: false, id: pending.id, received: pending.nextSeq, total: pending.total };
  }

  /**
   * Forget the transfer in progress.
   * @returns {{id: string, received: number, total: number}|null}
   */
  abort() {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return null;
    return { id: pending.id, received: pending.nextSeq, total: pending.total };
  }
}

module.exports = { ChunkReassembler, ChunkError };
