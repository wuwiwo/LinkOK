'use strict';

/**
 * Unit tests: time and id formatting (PROTOCOL.md §13, §4).
 *
 * The id rule is load-bearing — an id ends up in a file path and a URL, so a
 * colon in it breaks `GET /api/history/:id/raw` and Windows paths alike.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isoWithOffset,
  compactUtcId,
  localDateFolder,
  localDayKey,
  offsetString,
  toDate,
} = require('../src/time');

test('isoWithOffset carries the local UTC offset', () => {
  const value = isoWithOffset(new Date('2026-11-25T16:46:51.132+08:00'));
  // The exact wall-clock depends on the machine's zone, but the shape and the
  // offset must always be explicit.
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
});

test('isoWithOffset round-trips to the same instant', () => {
  const original = new Date('2026-11-25T16:46:51.132+08:00');
  const parsed = new Date(isoWithOffset(original));
  assert.equal(parsed.getTime(), original.getTime(), 'the offset must preserve the instant');
});

test('isoWithOffset pads every field', () => {
  const value = isoWithOffset(new Date(2026, 0, 5, 3, 4, 5, 6));
  assert.match(value, /^2026-01-05T03:04:05\.006/);
});

test('offsetString is always signed and zero-padded', () => {
  const value = offsetString(new Date());
  assert.match(value, /^[+-]\d{2}:\d{2}$/);
});

test('compactUtcId contains no colon, dash or dot (PROTOCOL §13)', () => {
  const id = compactUtcId(new Date('2026-11-25T16:46:51.132+08:00'));
  assert.equal(id, '20261125T084651132', 'the compact form is UTC, not local');
  assert.ok(!id.includes(':'), 'a colon would break paths and URLs');
  assert.ok(!id.includes('-'));
  assert.ok(!id.includes('.'));
});

test('compactUtcId is stable for the same instant regardless of local zone', () => {
  const isoA = '2026-11-25T16:46:51.132+08:00';
  const isoB = '2026-11-25T08:46:51.132Z';
  assert.equal(compactUtcId(new Date(isoA)), compactUtcId(new Date(isoB)));
});

test('localDateFolder is a filesystem-safe YYYY-MM-DD', () => {
  const folder = localDateFolder(new Date(2026, 10, 25, 16, 46));
  assert.equal(folder, '2026-11-25');
  assert.match(folder, /^\d{4}-\d{2}-\d{2}$/);
});

test('localDayKey matches the date folder so logs and History agree', () => {
  const date = new Date(2026, 10, 25, 23, 59);
  assert.equal(localDayKey(date), localDateFolder(date));
});

test('toDate accepts Dates, ISO strings and epoch millis', () => {
  const date = new Date('2026-11-25T16:46:51.132+08:00');
  assert.equal(toDate(date, 'x').getTime(), date.getTime());
  assert.equal(toDate('2026-11-25T16:46:51.132+08:00', 'x').getTime(), date.getTime());
  assert.equal(toDate(date.getTime(), 'x').getTime(), date.getTime());
});

test('toDate rejects everything else with a named error', () => {
  for (const value of [null, undefined, '', '   ', 'not-a-date', {}, [], Number.NaN, new Date('invalid')]) {
    assert.throws(
      () => toDate(value, 'arrivedAt'),
      /arrivedAt/,
      `${JSON.stringify(value)} must be rejected with the field name`,
    );
  }
});

test('a HistoryItem id built from compactUtcId survives URL encoding unchanged', () => {
  const id = `${compactUtcId(new Date())}-3f2a1b`;
  assert.equal(encodeURIComponent(id), id, 'an id must need no escaping in a URL');
  assert.equal(decodeURIComponent(encodeURIComponent(id)), id);
});
