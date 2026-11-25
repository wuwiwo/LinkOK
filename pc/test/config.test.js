'use strict';

/**
 * Unit tests: Config validation, persistence and repair (PROTOCOL.md §7).
 *
 * `retentionDays` is the only setting that destroys data, so its validation is
 * tested exhaustively: every value outside {0,7,15,30} must be refused with 400
 * rather than silently coerced.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  ConfigStore,
  RETENTION_CHOICES,
  defaultConfig,
  mergeConfig,
  loadConfig,
} = require('../src/config');
const { TempDir } = require('./helpers');

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

/** @param {string} label */
function makeStore(label = 'config') {
  const dir = new TempDir(label);
  const store = new ConfigStore({ file: dir.join('config.json'), logger: QUIET_LOGGER });
  return { store, dir };
}

test('the documented defaults are what SPEC §8.3 says', () => {
  const config = defaultConfig();
  assert.equal(config.port, 8787);
  assert.equal(config.retentionDays, 30);
  assert.deepEqual(config.notifications, {
    enabled: true,
    captureDelivered: true,
    clipboardSynced: false,
    errors: true,
  });
  assert.equal(config.autostart, true);
  assert.equal(config.screenshotDir, '');
});

test('RETENTION: 0, 7, 15 and 30 are the only accepted values', () => {
  assert.deepEqual([...RETENTION_CHOICES], [0, 7, 15, 30]);

  const base = defaultConfig();
  for (const value of RETENTION_CHOICES) {
    const result = mergeConfig({ retentionDays: value }, base);
    assert.equal(result.ok, true, `${value} must be accepted`);
    assert.equal(result.config.retentionDays, value);
  }
});

test('RETENTION: every other value is refused with invalid_retention_days', () => {
  const base = defaultConfig();
  const rejected = [-1, 1, 3, 14, 29, 31, 60, 365, 7.5, Number.NaN, '7', '30', null, true, {}, [7]];

  for (const value of rejected) {
    const result = mergeConfig({ retentionDays: /** @type {any} */ (value) }, base);
    assert.equal(result.ok, false, `${JSON.stringify(value)} must be refused`);
    assert.equal(result.error, 'invalid_retention_days');
  }
});

test('a partial patch only changes the keys it names', () => {
  const base = defaultConfig();
  const result = mergeConfig({ retentionDays: 7 }, base);

  assert.equal(result.ok, true);
  assert.equal(result.config.retentionDays, 7);
  assert.equal(result.config.port, base.port, 'port must be untouched');
  assert.equal(result.config.autostart, base.autostart);
  assert.deepEqual(result.config.notifications, base.notifications);
});

test('notification toggles merge individually', () => {
  const base = defaultConfig();
  const result = mergeConfig({ notifications: { clipboardSynced: true } }, base);

  assert.equal(result.ok, true);
  assert.equal(result.config.notifications.clipboardSynced, true);
  assert.equal(result.config.notifications.enabled, true, 'untouched toggle keeps its value');
  assert.equal(result.config.notifications.captureDelivered, true);
});

test('unknown keys are refused rather than dropped', () => {
  const base = defaultConfig();

  const unknownTop = mergeConfig({ retentionDays: 7, sneaky: true }, base);
  assert.equal(unknownTop.ok, false);
  assert.equal(unknownTop.error, 'unknown_field');

  const unknownNested = mergeConfig({ notifications: { emails: true } }, base);
  assert.equal(unknownNested.ok, false);
  assert.equal(unknownNested.error, 'unknown_field');
});

test('invalid value types are refused', () => {
  const base = defaultConfig();
  assert.equal(mergeConfig({ port: 0 }, base).error, 'invalid_port');
  assert.equal(mergeConfig({ port: 70000 }, base).error, 'invalid_port');
  assert.equal(mergeConfig({ port: 8787.5 }, base).error, 'invalid_port');
  assert.equal(mergeConfig({ port: '8787' }, base).error, 'invalid_port');
  assert.equal(mergeConfig({ autostart: 'yes' }, base).error, 'invalid_autostart');
  assert.equal(mergeConfig({ screenshotDir: 42 }, base).error, 'invalid_screenshot_dir');
  assert.equal(mergeConfig({ notifications: { enabled: 'true' } }, base).error, 'invalid_notifications');
  assert.equal(mergeConfig({ notifications: 'none' }, base).error, 'invalid_notifications');
  assert.equal(mergeConfig(/** @type {any} */ (null), base).error, 'invalid_config');
  assert.equal(mergeConfig(/** @type {any} */ ([]), base).error, 'invalid_config');
});

test('a fresh ConfigStore writes the defaults to disk', () => {
  const { store, dir } = makeStore();
  const config = store.load();

  const file = dir.join('config.json');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), config);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file may be left behind');
});

test('patch() persists and is visible on the next load', () => {
  const { store, dir } = makeStore();
  store.load();

  const result = store.patch({ retentionDays: 15, notifications: { errors: false } });
  assert.equal(result.ok, true);

  const reopened = new ConfigStore({ file: dir.join('config.json'), logger: QUIET_LOGGER });
  const loaded = reopened.load();
  assert.equal(loaded.retentionDays, 15);
  assert.equal(loaded.notifications.errors, false);
});

test('patch() refuses an invalid retention value without touching the file', () => {
  const { store, dir } = makeStore();
  store.load();
  const before = fs.readFileSync(dir.join('config.json'), 'utf8');

  const result = store.patch({ retentionDays: 14 });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(dir.join('config.json'), 'utf8'), before, 'a refused patch must not write');
});

test('load() repairs an out-of-range retention value and says so', () => {
  const dir = new TempDir('config-repair');
  fs.writeFileSync(
    dir.join('config.json'),
    JSON.stringify({ port: 8787, retentionDays: 99, notifications: { enabled: true } }),
  );

  const { config, repaired } = loadConfig(dir.join('config.json'), QUIET_LOGGER);

  assert.equal(config.retentionDays, 30, 'an invalid retention must fall back to the default');
  assert.ok(repaired.includes('retentionDays'), 'the repair must be reported');
  // And the repaired file must be on disk, so the next start is clean.
  assert.equal(JSON.parse(fs.readFileSync(dir.join('config.json'), 'utf8')).retentionDays, 30);
});

test('load() keeps valid values and repairs only the invalid ones', () => {
  const dir = new TempDir('config-partial');
  fs.writeFileSync(
    dir.join('config.json'),
    JSON.stringify({
      port: 9000,
      retentionDays: 7,
      notifications: { enabled: false, captureDelivered: 'yes' },
      autostart: false,
      unknownKey: 1,
    }),
  );

  const { config, repaired } = loadConfig(dir.join('config.json'), QUIET_LOGGER);

  assert.equal(config.port, 9000, 'a valid port is kept');
  assert.equal(config.retentionDays, 7, 'a valid retention is kept');
  assert.equal(config.notifications.enabled, false);
  assert.equal(config.notifications.captureDelivered, true, 'an invalid toggle falls back');
  assert.equal(config.autostart, false);
  assert.ok(repaired.includes('notifications.captureDelivered'));
  assert.ok(repaired.includes('unknown:unknownKey'));
});

test('load() quarantines a corrupt config and falls back to defaults', () => {
  const dir = new TempDir('config-corrupt');
  const file = dir.join('config.json');
  fs.writeFileSync(file, '{ this is not json');

  const { config } = loadConfig(file, QUIET_LOGGER);

  assert.deepEqual(config, defaultConfig());
  const backups = fs.readdirSync(dir.path).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1, 'the damaged file must be kept for inspection');
});

test('a corrupt config does not brick a subsequent start', () => {
  const dir = new TempDir('config-recover');
  const file = dir.join('config.json');
  fs.writeFileSync(file, 'not json at all');

  loadConfig(file, QUIET_LOGGER);
  const second = loadConfig(file, QUIET_LOGGER);

  assert.equal(second.repaired.length, 0, 'the second load must be clean');
  assert.deepEqual(second.config, defaultConfig());
});

test('changing the port is accepted but logged as deferred', () => {
  const { store } = makeStore();
  store.load();
  QUIET_LOGGER.lines.length = 0;

  const result = store.patch({ port: 9000 });
  assert.equal(result.ok, true);
  assert.equal(result.config.port, 9000);

  const warned = QUIET_LOGGER.lines.some(
    (line) => line.level === 'warn' && line.message.includes('next time the Hub starts'),
  );
  assert.equal(warned, true, 'the user must be told the port changes on restart');
});

test('the store exposes an immutable snapshot', () => {
  const { store } = makeStore();
  store.load();
  store.patch({ retentionDays: 7 });

  const snapshot = store.snapshot();
  snapshot.retentionDays = 30;
  snapshot.notifications.enabled = false;

  assert.equal(store.get().retentionDays, 7, 'mutating a snapshot must not affect the store');
  assert.equal(store.get().notifications.enabled, true);
});
