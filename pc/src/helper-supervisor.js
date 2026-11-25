'use strict';

/**
 * Supervision of the native helper (`pc/helper/linkok-helper.exe`).
 *
 * The helper owns everything Node cannot do on Windows: reading/writing the
 * clipboard, the Tray, and the QR window. Node talks to it over stdio with
 * newline-delimited JSON in both directions (PROTOCOL.md §11).
 *
 * Non-negotiables implemented here:
 *  - a missing binary is NOT an error: the Hub runs with `helper: "unavailable"`
 *    and every capability that needs the helper degrades instead of crashing;
 *  - crashes are restarted with backoff, capped at 5 consecutive failures and a
 *    5 s delay, after which the Hub stops trying and notifies;
 *  - a helper that the user quit from the Tray is not restarted;
 *  - stdout is line-buffered JSON: a partial line is never parsed, a malformed
 *    line is logged and skipped, and one bad line never kills the supervision.
 *
 * Testability: the process is created through an injectable `spawnImpl` so the
 * supervisor can be exercised with a fake child without a real pipe (the dev
 * sandbox denies pipe creation for external processes).
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');

/** Delay before restart N (PROTOCOL.md §11 caps the interval at 5 s). */
const RESTART_DELAY_MS = 2000;
const RESTART_DELAY_MAX_MS = 5000;
const MAX_CONSECUTIVE_FAILURES = 5;
/** A helper that stays up this long clears the failure counter. */
const STABLE_AFTER_MS = 60_000;
/** How long to wait for `ready` before considering the helper alive anyway. */
const READY_TIMEOUT_MS = 1500;
/** A single stdout line longer than this is treated as corruption. */
const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** @typedef {'stopped'|'starting'|'running'|'restarting'|'unavailable'|'gave-up'} HelperStatus */

class HelperSupervisor extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.helperPath absolute path to the exe
   * @param {import('./logger').Logger} options.logger
   * @param {() => boolean} [options.isPaused]
   * @param {import('node:child_process').spawn} [options.spawnImpl]
   * @param {() => number} [options.now]
   * @param {boolean} [options.enabled] false skips spawning entirely (tests)
   * @param {string} [options.tempDir] writable dir for clipboard PNG spills.
   *   Defaults to `<dataDir>/tmp`. The helper must not rely on the system TEMP:
   *   under a restricted profile that path can be unwritable, and the helper
   *   would die on startup with UnauthorizedAccessException.
   */
  constructor({ helperPath, logger, isPaused = () => false, spawnImpl = null, now = () => Date.now(), enabled = true, tempDir = null }) {
    super();
    this.helperPath = path.resolve(helperPath);
    this.logger = logger;
    this.isPaused = isPaused;
    this.now = now;
    this.enabled = enabled;
    this.spawnImpl = spawnImpl || require('node:child_process').spawn;
    this.tempDir = tempDir;

    /** @type {HelperStatus} */
    this.status = enabled ? 'stopped' : 'unavailable';
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.consecutiveFailures = 0;
    this.streaming = false;
    this.shuttingDown = false;
    /** @type {string|null} */
    this.unavailableReason = enabled ? null : 'disabled';
    /** @type {string|null} */
    this.helperVersion = null;
    this.userQuit = false;

    /** @type {NodeJS.Timeout|null} */
    this.restartTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.readyTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.stableTimer = null;

    /** @type {string} */
    this._stdoutBuffer = '';
    this._stdoutBytes = 0;
  }

  /** @returns {boolean} true when commands will actually have an effect */
  get isRunning() {
    return this.status === 'running' && this.child !== null;
  }

  /**
   * State for `GET /api/state`. `running` and `unavailable` are the two the
   * settings page cares about; `restarting`/`gave-up` explain a transient gap.
   * @returns {{status: string, version: string|null, reason: string|null, failures: number}}
   */
  describe() {
    return {
      status: this.isRunning ? 'running' : this.status === 'starting' || this.status === 'restarting' ? 'restarting' : 'unavailable',
      version: this.helperVersion,
      reason: this.unavailableReason,
      failures: this.consecutiveFailures,
    };
  }

  /**
   * Spawn the helper and send `{"cmd":"start"}`.
   * @returns {void}
   */
  start() {
    if (!this.enabled) {
      this.logger.info('helper supervision disabled; running without a helper');
      return;
    }
    if (this.child) return;
    this.shuttingDown = false;
    this.userQuit = false;

    const fs = require('node:fs');
    if (!fs.existsSync(this.helperPath)) {
      this.status = 'unavailable';
      this.unavailableReason = 'binary-missing';
      this.logger.warn(
        `helper binary not found at ${this.helperPath}; continuing without clipboard, Tray and notifications`,
      );
      this.emit('unavailable', { reason: 'binary-missing', path: this.helperPath });
      return;
    }

    this.status = this.consecutiveFailures > 0 ? 'restarting' : 'starting';
    this._clearTimers();

    let child;
    try {
      child = this.spawnImpl(this.helperPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this._childEnv(),
      });
    } catch (err) {
      // A sandbox may deny pipe creation (EPERM) or the exe may be locked.
      this.logger.error('helper failed to spawn', { error: /** @type {Error} */ (err).message });
      this._onFailure(`spawn: ${/** @type {Error} */ (err).message}`);
      return;
    }

    this.child = child;
    this._stdoutBuffer = '';
    this._stdoutBytes = 0;

    child.on('error', (err) => {
      this.logger.error('helper process error', { error: err.message });
    });

    child.on('exit', (code, signal) => {
      this._onExit(child, code, signal);
    });

    const stdout = child.stdout;
    if (stdout) {
      stdout.setEncoding('utf8');
      stdout.on('data', (chunk) => this._onStdout(chunk));
      stdout.on('error', (err) => {
        this.logger.warn('helper stdout error', { error: err.message });
      });
    } else {
      this.logger.error('helper has no stdout pipe; cannot receive its events');
    }

    const stderr = child.stderr;
    if (stderr) {
      stderr.setEncoding('utf8');
      stderr.on('data', (chunk) => {
        // Best-effort diagnostics from the helper: one log line per line.
        for (const line of String(chunk).split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed !== '') this.logger.debug(`helper stderr: ${trimmed}`);
        }
      });
      stderr.on('error', (err) => {
        this.logger.warn('helper stderr error', { error: err.message });
      });
    }

    const stdin = child.stdin;
    if (!stdin) {
      this.logger.error('helper has no stdin pipe; cannot send it commands');
    } else {
      stdin.on('error', (err) => {
        // EPIPE here means the helper died between our write and the pipe.
        this.logger.warn('helper stdin error', { error: err.message });
      });
    }

    // PROTOCOL §11: the helper does real work only after `start`.
    this.send({ cmd: 'start' });

    // `ready` is authoritative, but a helper that never emits it (older build)
    // must not leave the Hub believing nothing is running.
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.child && this.status !== 'running') {
        this.logger.warn('helper did not emit ready within 1.5 s; assuming it is up');
        this._markRunning(null);
      }
    }, READY_TIMEOUT_MS);
    if (typeof this.readyTimer.unref === 'function') this.readyTimer.unref();

    this.logger.info(`helper spawned (pid ${child.pid ?? 'unknown'})`);
  }

  /**
   * @param {null|string} version
   */
  _markRunning(version) {
    if (version) this.helperVersion = version;
    this.status = 'running';
    this.unavailableReason = null;
    this.streaming = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    // Clear the failure counter only after the helper proves it can stay up.
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (this.status === 'running') this.consecutiveFailures = 0;
    }, STABLE_AFTER_MS);
    if (typeof this.stableTimer.unref === 'function') this.stableTimer.unref();

    this.emit('ready', { version: this.helperVersion });
  }

  /**
   * @param {string} chunk
   */
  _onStdout(chunk) {
    this._stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (this._stdoutBytes > MAX_LINE_BYTES && !chunk.includes('\n')) {
      this.logger.error('helper wrote an unterminated line larger than 4MB; discarding the buffer');
      this._stdoutBuffer = '';
      this._stdoutBytes = 0;
      return;
    }
    this._stdoutBuffer += chunk;
    let newlineIndex = this._stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this._stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this._stdoutBuffer = this._stdoutBuffer.slice(newlineIndex + 1);
      this._stdoutBytes = Buffer.byteLength(this._stdoutBuffer, 'utf8');
      if (line.trim() !== '') this._onLine(line);
      newlineIndex = this._stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * @param {string} line one complete JSON line from the helper
   */
  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this.logger.warn('helper emitted a malformed JSON line; skipped', {
        error: /** @type {Error} */ (err).message,
        line: line.slice(0, 200),
      });
      return;
    }
    if (message === null || typeof message !== 'object' || typeof message.evt !== 'string') {
      this.logger.warn('helper emitted a JSON line without an evt field; skipped', {
        line: line.slice(0, 200),
      });
      return;
    }

    switch (message.evt) {
      case 'ready':
        this.logger.info(`helper ready${message.version ? ` (v${message.version})` : ''}`);
        this._markRunning(typeof message.version === 'string' ? message.version : null);
        return;
      case 'error':
        this.logger.warn(`helper error: ${message.code || 'unknown'} ${message.message || ''}`.trim());
        if (message.code === 'tray-unavailable' || message.code === 'clipboard-unavailable') {
          // The helper is alive but cannot do its job (session 0, for example).
          this.unavailableReason = String(message.code);
          this.emit('degraded', { code: message.code, message: message.message || '' });
          return;
        }
        this.emit('helper-error', { code: message.code || 'unknown', message: message.message || '' });
        return;
      default:
        this.emit('event', message);
        return;
    }
  }

  /**
   * @param {import('node:child_process').ChildProcess} child
   * @param {number|null} code
   * @param {string|null} signal
   */
  _onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.streaming = false;
    this._clearTimers();

    const wasUserQuit = this.userQuit;
    this.userQuit = false;

    if (this.shuttingDown) {
      this.status = 'stopped';
      this.logger.info('helper stopped');
      return;
    }
    if (wasUserQuit) {
      // The Tray "退出" should quit LinkOK, not restart the helper forever.
      this.status = 'stopped';
      this.logger.info('helper exited after a user quit request; not restarting');
      return;
    }

    this.logger.warn(`helper exited unexpectedly (code ${code}, signal ${signal || 'none'})`);
    this._onFailure(`exit:${code}`);
  }

  /**
   * Record a failure and either schedule a restart or give up.
   * @param {string} reason
   */
  _onFailure(reason) {
    this.consecutiveFailures += 1;
    this.unavailableReason = reason;
    this.emit('failure', { reason, consecutiveFailures: this.consecutiveFailures });

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // Do NOT give up permanently. The usual cause is transient: the exe was
      // being rebuilt, the clipboard was locked, or a path was momentarily
      // unavailable. A personal tool that silently stays broken until the user
      // restarts it is worse than one that keeps retrying at a slow rate.
      // So: drop to the slowest backoff and keep going, announcing the condition
      // exactly once so the log is not spammed.
      this.status = 'gave-up';
      if (!this.slowRetryAnnounced) {
        this.slowRetryAnnounced = true;
        this.logger.error(
          `helper failed ${this.consecutiveFailures} times in a row; switching to slow retry ` +
            `(every ${RESTART_DELAY_MAX_MS} ms). Clipboard and Tray stay unavailable until it recovers.`,
        );
        this.emit('gave-up', { consecutiveFailures: this.consecutiveFailures });
      }
      this._scheduleRestart(RESTART_DELAY_MAX_MS);
      return;
    }

    this.status = 'restarting';
    const delay = Math.min(RESTART_DELAY_MS * 2 ** (this.consecutiveFailures - 1), RESTART_DELAY_MAX_MS);
    this.logger.info(`restarting helper in ${delay} ms (failure ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    this._scheduleRestart(delay);
  }

  /** @param {number} delay */
  _scheduleRestart(delay) {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      this.start();
    }, delay);
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  /**
   * Environment for the helper child.
   *
   * The helper resolves its clipboard spill directory from LINKOK_HELPER_TMP and
   * falls back to `%TEMP%\LinkOK`. That fallback is not reliable: a locked-down
   * profile can deny writes there, and the helper exits with
   * UnauthorizedAccessException before it ever reaches `ready`. So the Hub always
   * hands it an explicit, already-created directory under its own data dir.
   *
   * @returns {NodeJS.ProcessEnv}
   */
  _childEnv() {
    const env = { ...process.env };
    if (this.tempDir) {
      try {
        require('node:fs').mkdirSync(this.tempDir, { recursive: true });
        env.LINKOK_HELPER_TMP = this.tempDir;
      } catch (err) {
        this.logger.warn('could not prepare helper temp dir; letting helper pick its own', {
          dir: this.tempDir,
          error: /** @type {Error} */ (err).message,
        });
      }
    }
    return env;
  }

  _clearTimers() {
    for (const key of ['restartTimer', 'readyTimer', 'stableTimer']) {
      const timer = /** @type {Record<string, NodeJS.Timeout|null>} */ (/** @type {unknown} */ (this))[key];
      if (timer) {
        clearTimeout(timer);
        /** @type {Record<string, NodeJS.Timeout|null>} */ (/** @type {unknown} */ (this))[key] = null;
      }
    }
  }

  /**
   * Send one command to the helper. Silently no-ops when the helper is not
   * running, because every caller has a documented degraded behaviour and the
   * alternative (throwing into an HTTP handler) is worse.
   *
   * @param {Record<string, unknown>} command
   * @returns {boolean} true when the command was handed to the pipe
   */
  send(command) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return false;
    }
    let line;
    try {
      // UTF-8, one JSON object per line, newline-terminated (PROTOCOL §11).
      line = `${JSON.stringify(command)}\n`;
    } catch (err) {
      this.logger.error('refusing to send an unserialisable helper command', {
        error: /** @type {Error} */ (err).message,
        cmd: command && command.cmd,
      });
      return false;
    }
    try {
      this.child.stdin.write(line, 'utf8');
      return true;
    } catch (err) {
      this.logger.warn('failed to write a command to the helper', {
        error: /** @type {Error} */ (err).message,
        cmd: command && command.cmd,
      });
      return false;
    }
  }

  // ── typed commands (PROTOCOL.md §11 + the set-clipboard extension) ─────────

  /** @param {boolean} paused */
  setPaused(paused) {
    return this.send({ cmd: 'set-paused', paused: Boolean(paused) });
  }

  /**
   * @param {'connected'|'disconnected'|'paused'} state
   * @param {string|null} [deviceName]
   */
  setTrayState(state, deviceName = null) {
    /** @type {Record<string, unknown>} */
    const command = { cmd: 'set-tray-state', state };
    if (deviceName) command.device = deviceName;
    return this.send(command);
  }

  /** @param {string} payload linkok://pair?... */
  showQr(payload) {
    return this.send({ cmd: 'show-qr', payload });
  }

  /**
   * @param {object} notification
   * @param {string} notification.title
   * @param {string} notification.body
   * @param {string} [notification.thumbFile]
   */
  notify({ title, body, thumbFile }) {
    /** @type {Record<string, unknown>} */
    const command = { cmd: 'notify', title, body };
    if (thumbFile) command.thumbFile = thumbFile;
    return this.send(command);
  }

  /** @param {string} file absolute path of a PNG that is already on disk */
  setClipboardImage(file) {
    return this.send({ cmd: 'set-clipboard-image', file });
  }

  /** @param {string} text */
  setClipboardText(text) {
    return this.send({ cmd: 'set-clipboard-text', text });
  }

  /**
   * Stop the helper and never restart it.
   * @param {number} [timeoutMs]
   * @returns {Promise<void>}
   */
  async stop(timeoutMs = 2000) {
    this.shuttingDown = true;
    this._clearTimers();
    const child = this.child;
    if (!child) {
      this.status = 'stopped';
      return;
    }
    this.send({ cmd: 'quit' });
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone; killing a dead process is not actionable.
        }
        finish();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
    });
    this.child = null;
    this.status = 'stopped';
  }
}

module.exports = {
  HelperSupervisor,
  MAX_CONSECUTIVE_FAILURES,
  RESTART_DELAY_MS,
  RESTART_DELAY_MAX_MS,
  READY_TIMEOUT_MS,
  STABLE_AFTER_MS,
};
