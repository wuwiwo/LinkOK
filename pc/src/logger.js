'use strict';

/**
 * Hub logging: stdout plus one file per day under `<data>/logs/`
 * (`hub-2026-11-25.log`, PROTOCOL.md §8.1).
 *
 * The log file is best-effort: if the directory is not writable the Hub keeps
 * running and says so on stdout once. Losing logs must never take the Hub down.
 */

const fs = require('node:fs');
const path = require('node:path');
const { isoWithOffset, localDayKey } = require('./time');

/** @typedef {'debug'|'info'|'warn'|'error'} LogLevel */

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

/** @type {LogLevel} */
const DEFAULT_LEVEL = 'info';

/**
 * @param {string} name
 * @returns {LogLevel}
 */
function normalizeLevel(name) {
  const value = String(name || '').toLowerCase();
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return /** @type {LogLevel} */ (value);
  }
  return DEFAULT_LEVEL;
}

class Logger {
  /**
   * @param {object} options
   * @param {string} options.logsDir directory for daily files
   * @param {LogLevel} [options.level]
   * @param {NodeJS.WritableStream} [options.stdout]
   * @param {() => Date} [options.now]
   * @param {boolean} [options.fileLogging] false disables the daily file (tests)
   */
  constructor({ logsDir, level = DEFAULT_LEVEL, stdout = process.stdout, now = () => new Date(), fileLogging = true }) {
    this.logsDir = logsDir;
    this.level = normalizeLevel(level);
    this.stdout = stdout;
    this.now = now;
    this.fileLogging = fileLogging;
    /** @type {fs.WriteStream|null} */
    this.stream = null;
    /** @type {string|null} */
    this.streamDay = null;
    /** @type {string|null} reason the file log is off, for the one-time warning */
    this.fileLoggingError = null;
    this.scope = null;

    if (this.fileLogging) {
      try {
        fs.mkdirSync(this.logsDir, { recursive: true });
      } catch (err) {
        this.fileLogging = false;
        this.fileLoggingError = /** @type {Error} */ (err).message;
      }
    }
  }

  /**
   * A logger that prefixes every line with `[scope]`. Shares the file stream
   * with its parent.
   * @param {string} scope
   * @returns {Logger}
   */
  child(scope) {
    const child = Object.create(Logger.prototype);
    child.logsDir = this.logsDir;
    child.level = this.level;
    child.stdout = this.stdout;
    child.now = this.now;
    child.fileLogging = this.fileLogging;
    child.fileLoggingError = this.fileLoggingError;
    child.scope = scope;
    // Share the parent's stream/day bookkeeping via the parent object itself.
    child._parent = this;
    return child;
  }

  /** @returns {Logger} the object that actually owns the file stream */
  get _owner() {
    return this._parent ? this._parent._owner : this;
  }

  /**
   * @param {LogLevel} level
   * @param {string} message
   * @param {unknown} [meta] JSON-serialisable extra context
   */
  log(level, message, meta) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    const stamp = isoWithOffset(this.now());
    const scope = this.scope ? ` [${this.scope}]` : '';
    let line = `${stamp} ${level.toUpperCase().padEnd(5)}${scope} ${message}`;
    if (meta !== undefined) {
      line += ` ${safeStringify(meta)}`;
    }
    line += '\n';

    try {
      this.stdout.write(line);
    } catch (err) {
      // A closed stdout (piped into a dead parent) must not crash the Hub.
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EPIPE') throw err;
    }

    const owner = this._owner;
    if (!owner.fileLogging) return;
    try {
      owner._streamFor(this.now()).write(line);
    } catch (err) {
      owner.fileLogging = false;
      owner.fileLoggingError = /** @type {Error} */ (err).message;
      this.stdout.write(
        `${stamp} WARN  [logger] file logging disabled: ${owner.fileLoggingError}\n`,
      );
    }
  }

  /**
   * @param {Date} date
   * @returns {fs.WriteStream}
   */
  _streamFor(date) {
    const day = localDayKey(date);
    if (this.stream && this.streamDay === day) return this.stream;
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    const file = path.join(this.logsDir, `hub-${day}.log`);
    const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (err) => {
      this.fileLogging = false;
      this.fileLoggingError = err.message;
      try {
        this.stdout.write(`${isoWithOffset(this.now())} WARN  [logger] file logging disabled: ${err.message}\n`);
      } catch {
        // stdout is gone too; nothing sensible left to do.
      }
    });
    this.stream = stream;
    this.streamDay = day;
    return stream;
  }

  /** @param {string} message @param {unknown} [meta] */
  debug(message, meta) {
    this.log('debug', message, meta);
  }

  /** @param {string} message @param {unknown} [meta] */
  info(message, meta) {
    this.log('info', message, meta);
  }

  /** @param {string} message @param {unknown} [meta] */
  warn(message, meta) {
    this.log('warn', message, meta);
  }

  /** @param {string} message @param {unknown} [meta] */
  error(message, meta) {
    this.log('error', message, meta);
  }

  /** Flush and close the daily file. */
  close() {
    const owner = this._owner;
    if (owner.stream) {
      owner.stream.end();
      owner.stream = null;
      owner.streamDay = null;
    }
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return `"<unserialisable: ${/** @type {Error} */ (err).message}>"`;
  }
}

/**
 * A logger that discards everything. Useful as a default in unit tests.
 * @returns {Logger}
 */
function createNullLogger() {
  const sink = { write() {} };
  const logger = new Logger({ logsDir: path.join(process.cwd(), '.linkok-null-logs'), stdout: sink, fileLogging: false });
  return logger;
}

module.exports = { Logger, normalizeLevel, createNullLogger, LEVEL_WEIGHT };
