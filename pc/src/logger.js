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
 * 单个日志文件的大小上限（50 MB）。超过就切分片。
 *
 * 为什么必须要有：按日切分不够。一个不断重连的失效客户端能让日志在几小时内
 * 涨到几个 GB（实测 5.3 GB），把磁盘吃掉、让 GUI 读日志卡死。
 */
const MAX_LOG_BYTES = 50 * 1024 * 1024;
/** 同一天最多保留几个分片；更早的自动删除。 */
const MAX_LOG_FILES = 5;

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
    /** 当前分片的标识（日期 + 分片号），变化时重建流 */
    this.streamKey = null;
    /** 当前分片已写入的字节数 */
    this.streamBytes = 0;
    /** 当天的分片序号，0 表示不分片（hub-YYYY-MM-DD.log） */
    this.rollIndex = 0;
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
      const nowDate = this.now();
      owner._streamFor(nowDate).write(line);
      // 记账并在超限时轮转。没有这一步，文件只会无限增长 ——
      // 实测有用户因为手机 token 失效反复重连，日志一天涨到 5.3 GB。
      owner._accountBytes(Buffer.byteLength(line, 'utf8'), nowDate);
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
    // 同一天内还要考虑文件是否已经太大：按日切分不够，
    // 一个刷屏的日志源能在几小时内写出几个 GB（实测 5.3 GB）。
    const rollSuffix = this.rollIndex > 0 ? `.${this.rollIndex}` : '';
    const key = `${day}${rollSuffix}`;

    if (this.stream && this.streamKey === key) return this.stream;

    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }

    this.streamDay = day;
    this.streamKey = key;
    this.streamBytes = 0;

    const file = path.join(this.logsDir, `hub-${day}${rollSuffix}.log`);
    // 启动时若已有文件，先取它的大小，避免从 0 计数导致上限失效。
    try {
      this.streamBytes = fs.statSync(file).size;
    } catch {
      this.streamBytes = 0;
    }

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

    // 启动时已经超限（上一个会话刷爆了）→ 立刻轮转，别继续往一个巨大文件里追加。
    if (this.streamBytes >= MAX_LOG_BYTES) {
      this._roll(date);
    }
    return this.stream;
  }

  /**
   * 关闭当前文件并切换到下一个分片。
   * 只保留最近 MAX_LOG_FILES 个分片，更早的删除 —— 磁盘是有限的，
   * 日志的价值远低于把用户的盘写满。
   *
   * @param {Date} date
   */
  _roll(date) {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
    this.rollIndex += 1;
    this.streamBytes = 0;
    this.streamKey = null;

    // 清掉过旧的分片
    try {
      const day = localDayKey(date);
      const pattern = new RegExp(`^hub-${day}\\.\\d+\\.log$`);
      const files = fs
        .readdirSync(this.logsDir)
        .filter((f) => pattern.test(f))
        .sort();
      const excess = files.length - (MAX_LOG_FILES - 1);
      for (let i = 0; i < excess; i += 1) {
        try {
          fs.unlinkSync(path.join(this.logsDir, files[i]));
        } catch {
          // 删不掉就算了，不影响写日志。
        }
      }
    } catch {
      // 目录不可读时不阻塞主流程。
    }
  }

  /**
   * 记录刚写入的字节数，超过阈值就轮转。
   * @param {number} bytes
   * @param {Date} date
   */
  _accountBytes(bytes, date) {
    this.streamBytes += bytes;
    if (this.streamBytes >= MAX_LOG_BYTES) {
      this._roll(date);
    }
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

module.exports = { Logger, normalizeLevel, createNullLogger, LEVEL_WEIGHT, MAX_LOG_BYTES, MAX_LOG_FILES };
