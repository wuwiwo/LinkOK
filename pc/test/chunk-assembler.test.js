'use strict';

/**
 * Unit tests: chunk reassembly (PROTOCOL.md §5.4).
 *
 * The rule that matters is "缺片则整条丢弃": a reassembled Capture must be
 * either byte-identical to what was sent or refused outright. There is no
 * "best effort" partial image, because a truncated PNG on the clipboard is
 * indistinguishable from a corrupt screenshot to the user.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { ChunkReassembler, ChunkError } = require('../src/chunk-assembler');
const { makeLargePng } = require('./helpers');

const CHUNK = 256 * 1024;

/**
 * Feed a full transfer through the reassembler the way `link.js` does.
 * @param {ChunkReassembler} reassembler
 * @param {string} id
 * @param {Buffer} data
 * @returns {{complete: boolean, data?: Buffer, chunks: number}}
 */
function feed(reassembler, id, data) {
  const total = Math.ceil(data.length / CHUNK);
  let outcome = null;
  for (let seq = 0; seq < total; seq += 1) {
    reassembler.announce({ id, seq, total });
    const slice = data.subarray(seq * CHUNK, Math.min((seq + 1) * CHUNK, data.length));
    outcome = reassembler.push(slice);
  }
  return { complete: Boolean(outcome && outcome.complete), data: outcome && outcome.data, chunks: total };
}

test('a 3-chunk transfer reassembles byte-for-byte', () => {
  const reassembler = new ChunkReassembler();
  const payload = crypto.randomBytes(CHUNK * 2 + 1234);

  const result = feed(reassembler, 'cap-1', payload);

  assert.equal(result.chunks, 3);
  assert.equal(result.complete, true);
  assert.equal(result.data.length, payload.length);
  assert.ok(result.data.equals(payload), 'reassembled bytes must equal the original');
  assert.equal(reassembler.inProgress, false, 'the reassembler must release its buffer');
});

test('a single-chunk transfer completes immediately', () => {
  const reassembler = new ChunkReassembler();
  const payload = Buffer.from('small image body');

  reassembler.announce({ id: 'cap-2', seq: 0, total: 1 });
  const outcome = reassembler.push(payload);

  assert.equal(outcome.complete, true);
  assert.ok(outcome.data.equals(payload));
});

test('a large real PNG survives the round trip intact', () => {
  const reassembler = new ChunkReassembler();
  const png = makeLargePng(1_400_000);
  assert.ok(png.length > 1024 * 1024, 'fixture must exceed the single-frame limit');

  const digestBefore = crypto.createHash('sha256').update(png).digest('hex');
  const result = feed(reassembler, 'cap-3', png);
  const digestAfter = crypto.createHash('sha256').update(result.data).digest('hex');

  assert.equal(digestAfter, digestBefore, 'SHA-256 must be identical after reassembly');
});

test('a gap in seq is rejected as incomplete', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-4', seq: 0, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));

  assert.throws(
    () => reassembler.announce({ id: 'cap-4', seq: 2, total: 3 }),
    (err) => err instanceof ChunkError && err.code === 'incomplete',
  );
});

test('a duplicate seq is rejected as incomplete', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-5', seq: 0, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));
  reassembler.announce({ id: 'cap-5', seq: 1, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));

  // seq 1 has already been consumed; the next expected seq is 2.
  assert.throws(
    () => reassembler.announce({ id: 'cap-5', seq: 1, total: 3 }),
    (err) => err instanceof ChunkError && err.code === 'incomplete',
  );
});

test('a re-sent seq 0 starts a fresh transfer rather than corrupting one', () => {
  // PROTOCOL §5.4 has no retransmit; a repeated seq 0 means the sender gave up
  // on the previous Capture and began again. It must replace, not append.
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-5b', seq: 0, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));
  reassembler.announce({ id: 'cap-5b', seq: 0, total: 3 });
  const outcome = reassembler.push(Buffer.from('restarted'));

  assert.equal(outcome.complete, false);
  assert.equal(outcome.received, 1);
  assert.equal(outcome.total, 3);
});

test('a chunk with no seq 0 is rejected as incomplete', () => {
  const reassembler = new ChunkReassembler();
  assert.throws(
    () => reassembler.announce({ id: 'cap-6', seq: 1, total: 3 }),
    (err) => err instanceof ChunkError && err.code === 'incomplete',
  );
});

test('a chunk id that does not match the transfer in progress is rejected', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-7', seq: 0, total: 2 });
  reassembler.push(Buffer.alloc(CHUNK));

  assert.throws(
    () => reassembler.announce({ id: 'cap-8', seq: 1, total: 2 }),
    (err) => err instanceof ChunkError && err.code === 'incomplete',
  );
});

test('a total that changes mid-transfer is rejected', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-9', seq: 0, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));

  assert.throws(
    () => reassembler.announce({ id: 'cap-9', seq: 1, total: 4 }),
    (err) => err instanceof ChunkError && err.code === 'malformed',
  );
});

test('malformed chunk metadata is reported, not coerced', () => {
  const reassembler = new ChunkReassembler();
  assert.throws(() => reassembler.announce(/** @type {any} */ (null)), ChunkError);
  assert.throws(() => reassembler.announce({ id: '', seq: 0, total: 1 }), ChunkError);
  assert.throws(() => reassembler.announce({ id: 'x', seq: -1, total: 1 }), ChunkError);
  assert.throws(() => reassembler.announce({ id: 'x', seq: 0, total: 0 }), ChunkError);
  assert.throws(() => reassembler.announce({ id: 'x', seq: '0', total: 1 }), ChunkError);
  assert.throws(() => reassembler.announce({ id: 'x', seq: 5, total: 3 }), ChunkError);
});

test('a binary frame with no announcement is rejected', () => {
  const reassembler = new ChunkReassembler();
  assert.throws(
    () => reassembler.push(Buffer.alloc(10)),
    (err) => err instanceof ChunkError && err.code === 'malformed',
  );
});

test('a transfer that exceeds the size cap is aborted', () => {
  const reassembler = new ChunkReassembler({ maxBytes: CHUNK + 10 });
  reassembler.announce({ id: 'cap-10', seq: 0, total: 4 });
  reassembler.push(Buffer.alloc(CHUNK));

  assert.throws(
    () => reassembler.push(Buffer.alloc(100)),
    (err) => err instanceof ChunkError && err.code === 'too_large',
  );
  assert.equal(reassembler.inProgress, false, 'an oversized transfer must be dropped, not kept');
});

test('a chunk total above the chunk cap is rejected', () => {
  const reassembler = new ChunkReassembler({ maxChunks: 4 });
  assert.throws(
    () => reassembler.announce({ id: 'cap-11', seq: 0, total: 5 }),
    (err) => err instanceof ChunkError && err.code === 'too_large',
  );
});

test('a new seq 0 replaces an abandoned transfer', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-12', seq: 0, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));

  // The Phone gave up and started a different Capture without finishing.
  reassembler.announce({ id: 'cap-13', seq: 0, total: 1 });
  const outcome = reassembler.push(Buffer.from('fresh'));

  assert.equal(outcome.complete, true);
  assert.equal(outcome.data.toString(), 'fresh');
});

test('abort() reports what was lost and clears the buffer', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-14', seq: 0, total: 3 });
  reassembler.push(Buffer.alloc(CHUNK));

  assert.deepEqual(reassembler.abort(), { id: 'cap-14', received: 1, total: 3 });
  assert.equal(reassembler.inProgress, false);
  assert.equal(reassembler.abort(), null, 'aborting twice is a no-op');
});

test('zero-length chunk bodies are accepted and do not corrupt the total', () => {
  const reassembler = new ChunkReassembler();
  reassembler.announce({ id: 'cap-15', seq: 0, total: 2 });
  assert.deepEqual(reassembler.push(Buffer.alloc(0)), {
    complete: false,
    id: 'cap-15',
    received: 1,
    total: 2,
  });
  reassembler.announce({ id: 'cap-15', seq: 1, total: 2 });
  const outcome = reassembler.push(Buffer.from('tail'));
  assert.equal(outcome.complete, true);
  assert.equal(outcome.data.toString(), 'tail');
});
