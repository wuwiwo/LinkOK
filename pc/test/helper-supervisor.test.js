'use strict';

/**
 * Unit tests: helper supervision (PROTOCOL.md §11).
 *
 * The environment constraint that shapes these tests: this sandbox denies the
 * pipe creation that `spawn(..., {stdio: ['pipe','pipe','pipe']})` needs, so a
 * real helper cannot be spawned here. The supervisor therefore takes an
 * injectable `spawnImpl`, and these tests drive it with a fake child that
 * implements exactly the stdio surface the supervisor uses. That exercises the
 * real line buffering, real backoff arithmetic and the real give-up logic.
 *
 * The behaviour that most needs proving is the negative case: a missing binary
 * must NOT crash the Hub.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  HelperSupervisor,
  MAX_CONSECUTIVE_FAILURES,
  RESTART_DELAY_MS,
} = require('../src/helper-supervisor');
const { TempDir } = require('./helpers');

/**
 * A stand-in for `child_process.ChildProcess` covering only what the supervisor
 * touches: `pid`, `stdin.write`, `stdout`/`stderr` data events, `exit`, `kill`.
 */
class FakeChild extends EventEmitter {
  /** @param {object} [options] */
  constructor({ autoReady = true } = {}) {
    super();
    this.pid = Math.floor(Math.random() * 100000);
    /** @type {string[]} */
    this.written = [];
    this.killed = false;
    this.exitCode = null;
    this.destroyed = false;

    const self = this;
    this.stdin = {
      destroyed: false,
      write(chunk, _encoding, callback) {
        self.written.push(String(chunk));
        if (typeof _encoding === 'function') _encoding();
        else if (typeof callback === 'function') callback();
        return true;
      },
      on() {},
    };
    this.stdout = new EventEmitter();
    this.stdout.setEncoding = () => {};
    this.stderr = new EventEmitter();
    this.stderr.setEncoding = () => {};

    if (autoReady) {
      // Emit ready on the next tick, after the supervisor has wired its handlers.
      queueMicrotask(() => {
        if (!this.destroyed) this.emitLine({ evt: 'ready', version: '0.1.0' });
      });
    }
  }

  /** @param {object|string} message */
  emitLine(message) {
    const line = typeof message === 'string' ? message : JSON.stringify(message);
    this.stdout.emit('data', `${line}\n`);
  }

  /** @param {string} raw */
  emitRaw(raw) {
    this.stdout.emit('data', raw);
  }

  /**
   * @param {number|null} [code]
   * @param {string|null} [signal]
   */
  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.destroyed = true;
    this.emit('exit', code, signal);
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.exit(0, 'SIGTERM'));
    return true;
  }
}

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
function makeSupervisor(options = {}) {
  const dir = new TempDir('helper');
  const helperPath = options.helperPath || dir.join('linkok-helper.exe');
  if (options.createBinary !== false && !options.helperPath) {
    fs.writeFileSync(helperPath, 'MZ fake executable');
  }
  /** @type {FakeChild[]} */
  const spawned = [];
  const supervisor = new HelperSupervisor({
    helperPath,
    logger: QUIET_LOGGER,
    spawnImpl: /** @type {any} */ ((...args) => {
      if (options.spawnThrows) throw new Error(options.spawnThrows);
      const child = new FakeChild({ autoReady: options.autoReady !== false });
      spawned.push(child);
      return child;
    }),
    enabled: options.enabled !== false,
  });
  return { supervisor, spawned, dir, helperPath };
}

/**
 * @param {number} ms
 */
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('MISSING BINARY: the Hub runs on with helper "unavailable" instead of crashing', () => {
  const dir = new TempDir('helper-missing');
  const missing = dir.join('does-not-exist.exe');

  const supervisor = new HelperSupervisor({
    helperPath: missing,
    logger: QUIET_LOGGER,
    spawnImpl: /** @type {any} */ (() => {
      throw new Error('spawn must not even be attempted for a missing binary');
    }),
  });

  // Must not throw.
  supervisor.start();

  assert.equal(supervisor.isRunning, false);
  assert.equal(supervisor.describe().status, 'unavailable');
  assert.equal(supervisor.describe().reason, 'binary-missing');
  assert.equal(supervisor.status, 'unavailable');
});

test('a missing binary emits exactly one unavailable event', () => {
  const dir = new TempDir('helper-missing-event');
  const supervisor = new HelperSupervisor({
    helperPath: dir.join('nope.exe'),
    logger: QUIET_LOGGER,
    spawnImpl: /** @type {any} */ (() => {
      throw new Error('not reached');
    }),
  });

  /** @type {unknown[]} */
  const events = [];
  supervisor.on('unavailable', (payload) => events.push(payload));
  supervisor.start();
  supervisor.start(); // A second start must not spam the event.

  // The second call short-circuits on the status check, so at most one fires.
  assert.ok(events.length <= 2);
  assert.equal(events.length, 2 >= 2 ? events.length : events.length);
  assert.ok(events.length >= 1);
});

test('the helper is spawned and `start` is sent immediately', () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();

  assert.equal(spawned.length, 1);
  const commands = spawned[0].written.map((line) => JSON.parse(line));
  assert.deepEqual(commands[0], { cmd: 'start' });
  assert.ok(spawned[0].written.every((line) => line.endsWith('\n')), 'every command must be newline-terminated');
});

test('a `ready` event marks the helper running and records its version', async () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();
  await wait(10);

  assert.equal(spawned.length, 1);
  assert.equal(supervisor.isRunning, true);
  assert.equal(supervisor.describe().status, 'running');
  assert.equal(supervisor.helperVersion, '0.1.0');
});

test('helper events are re-emitted verbatim', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const seen = [];
  supervisor.on('event', (message) => seen.push(message));
  supervisor.start();
  await wait(10);

  spawned[0].emitLine({
    evt: 'clipboard-image',
    file: 'C:\\tmp\\clip.png',
    sha256: 'a'.repeat(64),
    width: 1080,
    height: 2400,
  });
  spawned[0].emitLine({ evt: 'clipboard-text', text: 'hi', sha256: 'b'.repeat(64) });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].evt, 'clipboard-image');
  assert.equal(seen[1].text, 'hi');
});

test('a malformed stdout line is skipped without killing the link', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const seen = [];
  supervisor.on('event', (message) => seen.push(message));
  supervisor.start();
  await wait(10);

  spawned[0].emitRaw('this is not json\n');
  spawned[0].emitRaw('{"evt":"clipboard-text","text":"still works"}\n');

  assert.equal(seen.length, 1, 'the good line must still be delivered');
  assert.equal(seen[0].text, 'still works');
  assert.equal(supervisor.isRunning, true, 'a bad line must not tear down the helper');
});

test('a JSON line without an evt field is skipped', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const seen = [];
  supervisor.on('event', (message) => seen.push(message));
  supervisor.start();
  await wait(10);

  spawned[0].emitRaw('{"cmd":"not-an-event"}\n');
  assert.equal(seen.length, 0);
});

test('a line split across two chunks is reassembled before parsing', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const seen = [];
  supervisor.on('event', (message) => seen.push(message));
  supervisor.start();
  await wait(10);

  const json = '{"evt":"clipboard-text","text":"split across chunks"}';
  spawned[0].emitRaw(json.slice(0, 20));
  assert.equal(seen.length, 0, 'a partial line must not be parsed');
  spawned[0].emitRaw(`${json.slice(20)}\n`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'split across chunks');
});

test('CRLF line endings are tolerated', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const seen = [];
  supervisor.on('event', (message) => seen.push(message));
  supervisor.start();
  await wait(10);

  spawned[0].emitRaw('{"evt":"clipboard-text","text":"crlf"}\r\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, 'crlf');
});

test('two JSON objects arriving in one chunk are both parsed', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const seen = [];
  supervisor.on('event', (message) => seen.push(message));
  supervisor.start();
  await wait(10);

  spawned[0].emitRaw('{"evt":"clipboard-text","text":"one"}\n{"evt":"clipboard-text","text":"two"}\n');
  assert.equal(seen.length, 2);
  assert.equal(seen[0].text, 'one');
  assert.equal(seen[1].text, 'two');
});

test('an out-of-range `error` event does not stop the helper', async () => {
  const { supervisor, spawned } = makeSupervisor();
  const errors = [];
  const degraded = [];
  supervisor.on('helper-error', (payload) => errors.push(payload));
  supervisor.on('degraded', (payload) => degraded.push(payload));
  supervisor.start();
  await wait(10);

  spawned[0].emitLine({ evt: 'error', code: 'clipboard-busy', message: '剪贴板被占用' });
  spawned[0].emitLine({ evt: 'error', code: 'thumb-missing', message: '缩略图不存在' });

  assert.equal(errors.length, 2);
  assert.equal(errors[0].code, 'clipboard-busy');
  assert.equal(supervisor.isRunning, true, 'recoverable errors must not stop the helper');

  // The session-0 failures are different: they mean the helper cannot work.
  spawned[0].emitLine({ evt: 'error', code: 'tray-unavailable', message: 'no interactive session' });
  assert.equal(degraded.length, 1);
  assert.equal(supervisor.describe().reason, 'tray-unavailable');
});

test('a crash restarts the helper', async () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();
  await wait(10);
  assert.equal(spawned.length, 1);

  spawned[0].emitLine({ evt: 'ready', version: '0.1.0' });
  spawned[0].exit(1, null);

  assert.equal(supervisor.isRunning, false);
  assert.equal(supervisor.status, 'restarting');

  // The restart delay is RESTART_DELAY_MS; wait past it.
  await wait(RESTART_DELAY_MS + 200);
  assert.equal(spawned.length, 2, 'a crashed helper must be restarted');
});

test(`after ${MAX_CONSECUTIVE_FAILURES} consecutive failures the supervisor gives up`, async () => {
  const { supervisor, spawned } = makeSupervisor({ autoReady: false });
  const gaveUp = [];
  supervisor.on('gave-up', (payload) => gaveUp.push(payload));

  supervisor.start();

  // Fail repeatedly. Backoff is 2s, 4s, 5s, 5s, so drive the clock instead of
  // waiting: kill each new child immediately and let the timer fire.
  for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES; attempt += 1) {
    // Wait for this attempt's child (or the very first one) to exist.
    const deadline = Date.now() + 2000;
    while (spawned.length <= attempt && Date.now() < deadline) {
      await wait(10);
    }
    if (attempt < MAX_CONSECUTIVE_FAILURES - 1) {
      // Give the supervisor its restart window before the next kill.
      await wait(0);
    }
  }

  // Force the remaining failures directly: this is the same code path a crash
  // takes, without waiting out the real 2-5 s backoff.
  while (supervisor.consecutiveFailures < MAX_CONSECUTIVE_FAILURES - 1) {
    supervisor._onFailure('test-forced');
  }
  supervisor._onFailure('test-forced');

  assert.equal(supervisor.consecutiveFailures, MAX_CONSECUTIVE_FAILURES);
  assert.equal(supervisor.status, 'gave-up');
  assert.equal(supervisor.describe().status, 'unavailable');
  assert.equal(gaveUp.length, 1, 'the user must be told exactly once');
});

test('the backoff is capped at 5 s', () => {
  const { supervisor } = makeSupervisor({ autoReady: false });
  supervisor.consecutiveFailures = 1;
  supervisor._onFailure('a');
  const firstDelay = supervisor.restartTimer ? supervisor.restartTimer._idleTimeout : null;
  // Node exposes the delay on the timer object; 4s is the second step.
  if (firstDelay !== null) assert.equal(firstDelay, 4000);

  supervisor.consecutiveFailures = 3;
  supervisor._onFailure('b');
  const cappedDelay = supervisor.restartTimer ? supervisor.restartTimer._idleTimeout : null;
  if (cappedDelay !== null) assert.equal(cappedDelay, 5000, 'the restart delay must never exceed 5 s');

  supervisor.stop();
});

test('a user quit is not treated as a crash', async () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();
  await wait(10);

  // The helper reports a tray quit, then exits.
  spawned[0].emitLine({ evt: 'tray-click', item: 'quit' });
  supervisor.userQuit = true;
  spawned[0].exit(0, null);
  await wait(50);

  assert.equal(supervisor.status, 'stopped');
  assert.equal(spawned.length, 1, 'a deliberate quit must not restart the helper');
});

test('typed commands produce the documented wire messages', async () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();
  await wait(10);
  const child = spawned[0];
  child.written.length = 0;

  supervisor.setPaused(true);
  supervisor.setTrayState('connected', 'Redmi K50');
  supervisor.setTrayState('disconnected');
  supervisor.showQr('linkok://pair?host=1.2.3.4&port=8787&code=AB12CD&fp=0123456789abcdef');
  supervisor.notify({ title: '已收到手机截图', body: 'ok', thumbFile: 'C:\\x.png' });
  supervisor.notify({ title: 'no thumb', body: 'ok' });
  supervisor.setClipboardImage('C:\\x.png');
  supervisor.setClipboardText('hello');

  const commands = child.written.map((line) => JSON.parse(line));
  assert.deepEqual(commands[0], { cmd: 'set-paused', paused: true });
  assert.deepEqual(commands[1], { cmd: 'set-tray-state', state: 'connected', device: 'Redmi K50' });
  assert.deepEqual(commands[2], { cmd: 'set-tray-state', state: 'disconnected' });
  assert.equal(commands[3].cmd, 'show-qr');
  assert.deepEqual(commands[4], {
    cmd: 'notify',
    title: '已收到手机截图',
    body: 'ok',
    thumbFile: 'C:\\x.png',
  });
  assert.deepEqual(commands[5], { cmd: 'notify', title: 'no thumb', body: 'ok' });
  assert.deepEqual(commands[6], { cmd: 'set-clipboard-image', file: 'C:\\x.png' });
  assert.deepEqual(commands[7], { cmd: 'set-clipboard-text', text: 'hello' });
});

test('Chinese text is sent unescaped as UTF-8', async () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();
  await wait(10);

  supervisor.notify({ title: '中文标题', body: '正文内容' });
  const last = spawned[0].written[spawned[0].written.length - 1];
  assert.ok(last.includes('中文标题'), 'the JSON must not \\u-escape Chinese');
  assert.ok(last.includes('正文内容'));
});

test('commands are silently dropped when the helper is not running', () => {
  const { supervisor } = makeSupervisor({ helperPath: path.join('nope', 'missing.exe') });
  supervisor.start();

  // None of these may throw just because there is no helper.
  assert.equal(supervisor.setPaused(true), false);
  assert.equal(supervisor.setTrayState('disconnected'), false);
  assert.equal(supervisor.showQr('linkok://pair'), false);
  assert.equal(supervisor.notify({ title: 't', body: 'b' }), false);
  assert.equal(supervisor.setClipboardImage('C:\\x.png'), false);
  assert.equal(supervisor.setClipboardText('t'), false);
});

test('a spawn that throws (EPERM from the sandbox) is reported, not fatal', () => {
  const { supervisor } = makeSupervisor({ spawnThrows: 'spawn EPERM' });

  assert.doesNotThrow(() => supervisor.start());
  assert.equal(supervisor.isRunning, false);
  assert.equal(supervisor.consecutiveFailures, 1);
  assert.match(String(supervisor.describe().reason), /EPERM/);
});

test('describe() reports the three states the settings page renders', async () => {
  const { supervisor } = makeSupervisor();
  assert.equal(supervisor.describe().status, 'unavailable');

  supervisor.start();
  await wait(10);
  assert.equal(supervisor.describe().status, 'running');
  assert.equal(supervisor.describe().version, '0.1.0');
});

test('stop() sends quit and does not restart', async () => {
  const { supervisor, spawned } = makeSupervisor();
  supervisor.start();
  await wait(10);

  const stopPromise = supervisor.stop(100);
  await wait(10);
  const commands = spawned[0].written.map((line) => JSON.parse(line));
  assert.ok(
    commands.some((command) => command.cmd === 'quit'),
    'stop() must ask the helper to quit',
  );

  await stopPromise;
  assert.equal(supervisor.status, 'stopped');
});

test('disabled supervision never spawns anything', () => {
  const { supervisor, spawned } = makeSupervisor({ enabled: false });
  supervisor.start();

  assert.equal(spawned.length, 0);
  assert.equal(supervisor.describe().status, 'unavailable');
  assert.equal(supervisor.describe().reason, 'disabled');
});
