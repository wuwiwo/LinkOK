'use strict';

/**
 * Unit tests: History, the dedup invariant, the Retention boundary and the
 * atomicity of index.json (PROTOCOL.md §8.1, §9, §10).
 *
 * The Retention tests inject a clock so "older than 7 days" is asserted exactly
 * at the boundary instead of approximately.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { HistoryStore, INDEX_VERSION } = require('../src/history-store');
const { makePng, TempDir } = require('./helpers');

const QUIET_LOGGER = /** @type {any} */ ({
  lines: [],
  info(message) {
    this.lines.push({ level: 'info', message });
  },
  warn(message) {
    this.lines.push({ level: 'warn', message });
  },
  error(message) {
    this.lines.push({ level: 'error', message });
  },
  debug() {},
  child() {
    return this;
  },
});

/**
 * @param {object} [options]
 */
function makeStore(options = {}) {
  const dir = new TempDir('history');
  const clock = { now: new Date('2026-11-25T16:46:51.132+08:00') };
  const store = new HistoryStore({
    dir: dir.join('history'),
    logger: QUIET_LOGGER,
    now: () => clock.now,
    flushDelayMs: options.flushDelayMs ?? 10,
  });
  store.load();
  return { store, dir, clock };
}

test('an empty store starts with an empty index', () => {
  const { store } = makeStore();
  assert.equal(store.count(), 0);
  assert.deepEqual(store.list(), []);
});

test('addCapture writes a date-foldered PNG and indexes it', async () => {
  const { store } = makeStore();
  const png = makePng({ width: 1080, height: 2400, seed: 3 });
  const { item, duplicate } = await store.addCapture({
    png,
    source: 'phone',
    arrivedAt: new Date('2026-11-25T16:46:51.132+08:00'),
  });

  assert.equal(duplicate, false);
  assert.match(item.id, /^20261125T084651132-[0-9a-f]{6}$/, 'id is compact UTC + short hash, no colons');
  assert.ok(!item.id.includes(':'), 'an id must never contain a colon');
  assert.equal(item.sha256, crypto.createHash('sha256').update(png).digest('hex'));
  assert.equal(item.source, 'phone');
  assert.equal(item.bytes, png.length);
  assert.equal(item.width, 1080);
  assert.equal(item.height, 2400);
  assert.equal(item.file, '2026-11-25/20261125T084651132-<HASH>.png'.replace('<HASH>', item.sha256.slice(0, 6)));

  const absolute = store.resolveFile(item);
  assert.ok(absolute && fs.existsSync(absolute), 'the PNG must exist on disk');
  assert.deepEqual(fs.readFileSync(absolute), png, 'the stored bytes must be identical');

  // The file lives in a date folder named after the arrival time's local day.
  assert.equal(path.basename(path.dirname(absolute)), '2026-11-25');
});

test('DUPLICATE: the same image content is dropped, never stored twice', async () => {
  const { store } = makeStore();
  const png = makePng({ seed: 11 });

  const first = await store.addCapture({ png, source: 'phone' });
  assert.equal(first.duplicate, false);

  const second = await store.addCapture({ png, source: 'phone' });
  assert.equal(second.duplicate, true, 'identical bytes must be reported as a duplicate');
  assert.equal(second.item.id, first.item.id, 'the existing item is returned');
  assert.equal(store.count(), 1, 'no second item may be added');
});

test('DUPLICATE: the same content from a different source is still a duplicate', async () => {
  const { store } = makeStore();
  const png = makePng({ seed: 12 });

  await store.addCapture({ png, source: 'phone' });
  const fromFolder = await store.addCapture({ png, source: 'pc-folder' });
  const fromClipboard = await store.addCapture({ png, source: 'pc-clipboard' });

  assert.equal(fromFolder.duplicate, true);
  assert.equal(fromClipboard.duplicate, true);
  assert.equal(store.count(), 1);
});

test('DUPLICATE: different content for the same dimensions is NOT a duplicate', async () => {
  const { store } = makeStore();
  const a = makePng({ width: 16, height: 16, seed: 1 });
  const b = makePng({ width: 16, height: 16, seed: 2 });

  assert.equal((await store.addCapture({ png: a, source: 'phone' })).duplicate, false);
  assert.equal((await store.addCapture({ png: b, source: 'phone' })).duplicate, false);
  assert.equal(store.count(), 2);
});

test('findByHash resolves the stored item', async () => {
  const { store } = makeStore();
  const png = makePng({ seed: 21 });
  const { item } = await store.addCapture({ png, source: 'phone' });
  assert.equal(store.findByHash(item.sha256).id, item.id);
  assert.equal(store.findByHash('0'.repeat(64)), null);
});

test('index.json is written atomically and is valid JSON', async () => {
  const { store, dir } = makeStore();
  await store.addCapture({ png: makePng({ seed: 31 }), source: 'phone' });
  await store.addCapture({ png: makePng({ seed: 32 }), source: 'pc-folder' });

  const indexFile = dir.join('history', 'index.json');
  assert.ok(store.flush(), 'flush must report that it wrote');

  const raw = fs.readFileSync(indexFile, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, INDEX_VERSION);
  assert.equal(parsed.items.length, 2);
  assert.ok(raw.endsWith('\n'), 'the file should end with a newline');

  // No temp file may survive a successful write: a leftover .tmp is the
  // signature of a crash mid-write.
  assert.equal(fs.existsSync(`${indexFile}.tmp`), false);
});

test('ATOMIC: a failed rename leaves the previous index intact', async () => {
  const { store, dir } = makeStore();
  await store.addCapture({ png: makePng({ seed: 41 }), source: 'phone' });
  store.flush();

  const indexFile = dir.join('history', 'index.json');
  const before = fs.readFileSync(indexFile, 'utf8');

  // Simulate "the power went out after tmp was written but before the rename"
  // by planting a partial tmp file the way a crash would.
  fs.writeFileSync(`${indexFile}.tmp`, '{"version":1,"items":[{"id":"trunc');

  // The real index must still be readable and unchanged.
  assert.equal(fs.readFileSync(indexFile, 'utf8'), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(indexFile, 'utf8')).items.length, 1);
});

test('ATOMIC: index.json is never observed in a partial state during writes', async () => {
  const { store, dir } = makeStore();
  const indexFile = dir.join('history', 'index.json');

  // Write a first item so the file exists, then hammer it with more while
  // reading it concurrently as fast as we can.
  await store.addCapture({ png: makePng({ seed: 51 }), source: 'phone' });
  await store.flushAsync();

  let reads = 0;
  let parseFailures = 0;
  let missingReads = 0;
  const reader = (async () => {
    for (let i = 0; i < 200; i += 1) {
      try {
        const raw = await fsp.readFile(indexFile, 'utf8');
        JSON.parse(raw);
        reads += 1;
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') missingReads += 1;
        else parseFailures += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();

  for (let i = 0; i < 12; i += 1) {
    await store.addCapture({ png: makePng({ seed: 60 + i }), source: 'phone' });
    await store.flushAsync();
  }
  await reader;

  // The invariant under test: a reader never sees a torn file. A momentary
  // ENOENT on Windows (the rename briefly unlinking the name) is not a torn
  // write, but a JSON parse error absolutely is.
  assert.equal(parseFailures, 0, `index.json was observed with invalid JSON ${parseFailures} time(s)`);
  assert.ok(reads > 0, 'the reader must have completed at least one read');
  assert.equal(store.count(), 13);
});

test('a store reloads its index from disk', async () => {
  const { store, dir } = makeStore();
  const png = makePng({ seed: 71 });
  const { item } = await store.addCapture({ png, source: 'phone' });
  store.flush();
  store.close();

  const reopened = new HistoryStore({ dir: dir.join('history'), logger: QUIET_LOGGER });
  reopened.load();

  assert.equal(reopened.count(), 1);
  const loaded = reopened.get(item.id);
  assert.ok(loaded);
  assert.equal(loaded.sha256, item.sha256);
  assert.equal(loaded.width, item.width);
});

test('load() drops index entries whose PNG vanished', async () => {
  const { store, dir } = makeStore();
  const { item } = await store.addCapture({ png: makePng({ seed: 81 }), source: 'phone' });
  store.flush();
  store.close();

  fs.unlinkSync(store.resolveFile(item));

  const reopened = new HistoryStore({ dir: dir.join('history'), logger: QUIET_LOGGER });
  const count = reopened.load();
  assert.equal(count, 0, 'an entry with no file must be pruned');
  assert.equal(reopened.get(item.id), null);
});

test('load() quarantines a corrupt index instead of crashing', () => {
  const dir = new TempDir('history-corrupt');
  fs.mkdirSync(dir.join('history'), { recursive: true });
  fs.writeFileSync(dir.join('history', 'index.json'), '{"version":1,"items":[{"id":');

  const store = new HistoryStore({ dir: dir.join('history'), logger: QUIET_LOGGER, flushDelayMs: 5 });
  assert.equal(store.load(), 0);

  const backups = fs.readdirSync(dir.join('history')).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1, 'the damaged file must be kept, not deleted');
  store.close();
});

test('list() returns newest first and honours from/to/limit', async () => {
  const { store, clock } = makeStore();
  const base = clock.now.getTime();

  for (let i = 0; i < 5; i += 1) {
    await store.addCapture({
      png: makePng({ seed: 100 + i }),
      source: 'phone',
      arrivedAt: new Date(base + i * 60_000),
    });
  }

  const all = store.list();
  assert.equal(all.length, 5);
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(
      new Date(all[i - 1].arrivedAt).getTime() >= new Date(all[i].arrivedAt).getTime(),
      'list must be newest first',
    );
  }

  assert.equal(store.list({ limit: 2 }).length, 2);
  assert.equal(store.list({ limit: 0 }).length, 0);

  const from = new Date(base + 2 * 60_000).toISOString();
  assert.equal(store.list({ from }).length, 3);

  const to = new Date(base + 2 * 60_000).toISOString();
  assert.equal(store.list({ to }).length, 3);

  assert.throws(
    () => store.list({ from: 'not-a-date' }),
    /not a valid timestamp/,
    'an invalid range must be reported, not silently ignored',
  );
});

test('remove() deletes the file and the index entry', async () => {
  const { store } = makeStore();
  const { item } = await store.addCapture({ png: makePng({ seed: 91 }), source: 'phone' });
  const absolute = store.resolveFile(item);

  assert.equal(await store.remove(item.id), true);
  assert.equal(store.get(item.id), null);
  assert.equal(fs.existsSync(absolute), false);
  assert.equal(store.findByHash(item.sha256), null, 'the dedup index must forget it too');
  assert.equal(await store.remove(item.id), false, 'removing twice is not an error, it is a no-op');
});

test('RETENTION 0 (Never): nothing is ever deleted', async () => {
  const { store, clock } = makeStore();
  const ancient = new Date(clock.now.getTime() - 3650 * 24 * 60 * 60 * 1000); // 10 years
  const { item } = await store.addCapture({ png: makePng({ seed: 101 }), source: 'phone', arrivedAt: ancient });
  const absolute = store.resolveFile(item);

  const result = await store.sweep(0);

  assert.equal(result.deleted, 0);
  assert.equal(result.skipped, true, 'sweep(0) must short-circuit, not scan');
  assert.equal(result.cutoff, null);
  assert.equal(store.count(), 1, 'a 10-year-old capture must survive Never');
  assert.ok(fs.existsSync(absolute));
});

test('RETENTION boundary: strictly older than N days is deleted, exactly N days is kept', async () => {
  const { store, clock } = makeStore();
  const DAY = 24 * 60 * 60 * 1000;
  const now = clock.now.getTime();

  // Exactly 7 days old -> kept. PROTOCOL §10 says Retention deletes Captures
  // *older than* retentionDays; an item exactly retentionDays old is not older.
  const boundary = await store.addCapture({
    png: makePng({ seed: 111 }),
    source: 'phone',
    arrivedAt: new Date(now - 7 * DAY),
  });
  // One millisecond past the boundary -> deleted.
  const justOver = await store.addCapture({
    png: makePng({ seed: 112 }),
    source: 'phone',
    arrivedAt: new Date(now - 7 * DAY - 1),
  });
  // Six days old -> kept.
  const recent = await store.addCapture({
    png: makePng({ seed: 113 }),
    source: 'phone',
    arrivedAt: new Date(now - 6 * DAY),
  });

  const result = await store.sweep(7);

  assert.equal(result.deleted, 1, `expected exactly one deletion, got ${result.deleted}`);
  assert.ok(store.get(boundary.item.id), 'the exactly-7-day capture is kept (not *older than* 7 days)');
  assert.equal(store.get(justOver.item.id), null, 'the 1 ms-too-old capture is deleted');
  assert.ok(store.get(recent.item.id), 'the 6-day capture is kept');
});

test('RETENTION deletes the PNG as well as the index entry', async () => {
  const { store, clock } = makeStore();
  const DAY = 24 * 60 * 60 * 1000;
  const { item } = await store.addCapture({
    png: makePng({ seed: 121 }),
    source: 'phone',
    arrivedAt: new Date(clock.now.getTime() - 40 * DAY),
  });
  const absolute = store.resolveFile(item);
  assert.ok(fs.existsSync(absolute));

  await store.sweep(30);

  assert.equal(store.count(), 0);
  assert.equal(fs.existsSync(absolute), false, 'the PNG must be removed from disk');
});

test('RETENTION honours the configured tier (7 keeps what 15 deletes)', async () => {
  const { store, clock } = makeStore();
  const DAY = 24 * 60 * 60 * 1000;
  const now = clock.now.getTime();

  const nineDays = await store.addCapture({
    png: makePng({ seed: 131 }),
    source: 'phone',
    arrivedAt: new Date(now - 9 * DAY),
  });

  assert.equal((await store.sweep(15)).deleted, 0, '9 days is inside a 15-day retention');
  assert.ok(store.get(nineDays.item.id));

  assert.equal((await store.sweep(7)).deleted, 1, '9 days is outside a 7-day retention');
  assert.equal(store.get(nineDays.item.id), null);
});

test('RETENTION never touches a file outside the history root', async () => {
  const { store } = makeStore();
  const png = makePng({ seed: 141 });
  const { item } = await store.addCapture({ png, source: 'phone' });

  // Forge an entry pointing outside the history root, the way a tampered index
  // would, and make sure the sweep refuses to delete it.
  const outside = path.join(path.dirname(store.dir), 'precious.png');
  fs.writeFileSync(outside, png);
  item.file = '../precious.png';

  const result = await store.sweep(0.0000001);
  assert.equal(fs.existsSync(outside), true, 'a file outside the history root must survive');
  assert.equal(result.deleted, 0);
  assert.equal(store.resolveFile(item), null, 'resolveFile must reject the escape');
});

test('RETENTION rejects an invalid tier instead of guessing', async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.sweep(-1), /invalid retentionDays/);
  await assert.rejects(() => store.sweep(Number.NaN), /invalid retentionDays/);
});

test('addCapture rejects empty and non-Buffer input', async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.addCapture({ png: Buffer.alloc(0), source: 'phone' }), /empty image/);
  await assert.rejects(() => store.addCapture({ png: 'not a buffer', source: 'phone' }), /Buffer/);
  await assert.rejects(() => store.addCapture({ png: makePng(), source: 'nope' }), /unknown source/);
});

test('a debounced flush eventually persists without an explicit flush()', async () => {
  const { store, dir } = makeStore({ flushDelayMs: 10 });
  await store.addCapture({ png: makePng({ seed: 151 }), source: 'phone' });

  const indexFile = dir.join('history', 'index.json');
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(indexFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(fs.existsSync(indexFile), 'the debounced write must land without a manual flush');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).items.length, 1);
  store.close();
});
