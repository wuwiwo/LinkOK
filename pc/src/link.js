'use strict';

/**
 * The Link: the live WebSocket connection to the Phone, plus everything that
 * must happen in a specific order on it (PROTOCOL.md §5, §12).
 *
 * Responsibilities:
 *  - hello handshake (`hello` -> `hello-ok`);
 *  - inbound Phone Captures, chunked or single-frame, deduplicated and stored;
 *  - outbound PC Captures, chunked above 1MB, delivered strictly serially and
 *    only one at a time, each waiting for `capture-result` or a 10 s timeout;
 *  - Clipboard Sync in both directions with Echo suppression;
 *  - ping/pong and the 45 s silence timeout.
 *
 * The busy state is deliberate: `enqueueCapture` never drops a PC Capture just
 * because the Link is down (SPEC §14 checklist: "PC screenshots must not pile up
 * and block"), it parks them in a bounded queue that drains on reconnect.
 */

const { EventEmitter } = require('node:events');
const { ChunkReassembler, ChunkError } = require('./chunk-assembler');
const { CLOSE_CODE } = require('./ws');
const { isPng, sniffImageFormat, readPngSize, tryReadPngSize } = require('./media');
const { sha256Hex, truncateUtf8 } = require('./crypto-util');
const { compactUtcId, isoWithOffset } = require('./time');

/** Chunk size for images larger than 1MB (SPEC §9.3). */
const CHUNK_SIZE = 256 * 1024;
const SINGLE_FRAME_LIMIT = 1024 * 1024;
/** How long to wait for `capture-result` before sending the next Capture (§12). */
const CAPTURE_RESULT_TIMEOUT_MS = 10_000;
/** No frame for this long means the Link is dead (PROTOCOL §5.5). */
const SILENCE_TIMEOUT_MS = 45_000;
/** Outbound Clipboard Sync text cap (SPEC D4). */
const CLIPBOARD_MAX_BYTES = 64 * 1024;
/** Bound on parked PC Captures so a long outage cannot eat memory. */
const MAX_QUEUED_CAPTURES = 32;

let captureSeq = 0;

class Link extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./ws').WebSocketConnection} options.connection
   * @param {import('./history-store').HistoryStore} options.history
   * @param {import('./echo-guard').EchoGuard} options.echoGuard
   * @param {import('./helper-supervisor').HelperSupervisor} options.helper
   * @param {import('./logger').Logger} options.logger
   * @param {() => number} [options.now]
   * @param {() => number} [options.clipboardMaxBytes]
   */
  constructor({ connection, history, echoGuard, helper, logger, now = () => Date.now(), clipboardMaxBytes = CLIPBOARD_MAX_BYTES, clipboardLog = null }) {
    super();
    this.connection = connection;
    this.history = history;
    this.echoGuard = echoGuard;
    this.helper = helper;
    this.logger = logger;
    this.now = now;
    this.clipboardMaxBytes = clipboardMaxBytes;
    /** @type {import('./clipboard-log').ClipboardLog|null} 观察用，可为空（测试里不关心） */
    this.clipboardLog = clipboardLog;

    this.helloReceived = false;
    this.deviceName = null;
    this.deviceModel = null;
    this.protocolVersion = null;
    this.connectedAt = new Date();

    /** @type {ChunkReassembler} */
    this.reassembler = new ChunkReassembler();
    /** @type {{id: string, sha256: string, arrivedAt: string, mime: string, bytes: number}|null} */
    this.pendingCapture = null;

    /** @type {Array<{png: Buffer, arrivedAt: Date, width: number|null, height: number|null}>} */
    this.outboundQueue = [];
    this.delivering = false;
    /** @type {{id: string, sha256: string, timer: NodeJS.Timeout}|null} */
    this.awaitingResult = null;

    this.closed = false;
    this.closedReason = null;

    this._silenceTimer = null;
    this._armSilenceTimer();

    connection.on('text', (text) => this._onText(text));
    connection.on('binary', (data) => this._onBinary(data));
    connection.on('close', (code, reason) => this._onClose(code, reason));
    connection.on('error', (err) => {
      this.logger.warn('link socket error', { error: err.message });
    });
  }

  _armSilenceTimer() {
    if (this._silenceTimer) clearTimeout(this._silenceTimer);
    this._silenceTimer = setTimeout(() => {
      this.logger.warn(`no frames for ${SILENCE_TIMEOUT_MS / 1000}s; closing the Link`);
      this.close('silence-timeout');
    }, SILENCE_TIMEOUT_MS);
    if (typeof this._silenceTimer.unref === 'function') this._silenceTimer.unref();
  }

  /** @returns {{connected: boolean, deviceName: string|null, since: string|null}} */
  describe() {
    return {
      connected: !this.closed,
      deviceName: this.deviceName,
      since: this.closed ? null : this.connectedAt.toISOString(),
    };
  }

  /**
   * @param {string} text
   */
  _onText(text) {
    this._armSilenceTimer();
    let message;
    try {
      message = JSON.parse(text);
    } catch (err) {
      this.logger.warn('phone sent a malformed JSON frame; ignored', {
        error: /** @type {Error} */ (err).message,
      });
      return;
    }
    if (message === null || typeof message !== 'object' || typeof message.type !== 'string') {
      this.logger.warn('phone sent a JSON frame without a type; ignored');
      return;
    }

    switch (message.type) {
      case 'hello':
        this._onHello(message);
        return;
      case 'capture':
        this._onCaptureHeader(message);
        return;
      case 'chunk':
        this._onChunkHeader(message);
        return;
      case 'clipboard':
        this._onClipboard(message);
        return;
      case 'ack':
        this.emit('ack', { id: String(message.id || '') });
        return;
      case 'capture-result':
        this._onCaptureResult(message);
        return;
      case 'ping':
        this.connection.sendText({ type: 'pong' });
        return;
      case 'pong':
        return;
      default:
        this.logger.debug(`phone sent an unhandled message type: ${message.type}`);
    }
  }

  /** @param {Record<string, any>} message */
  _onHello(message) {
    if (this.helloReceived) {
      this.logger.debug('phone re-sent hello; ignoring');
      return;
    }
    this.helloReceived = true;
    this.deviceName = typeof message.deviceName === 'string' ? message.deviceName : null;
    this.deviceModel = typeof message.deviceModel === 'string' ? message.deviceModel : null;
    this.protocolVersion = Number.isInteger(message.protocolVersion) ? message.protocolVersion : null;
    this.logger.info(`hello from ${this.deviceName || 'unknown device'}`, {
      model: this.deviceModel,
      protocolVersion: this.protocolVersion,
    });
    this.connection.sendText({ type: 'hello-ok', protocolVersion: 1 });
    this.emit('hello', { deviceName: this.deviceName, deviceModel: this.deviceModel });
    this._drainQueue();
  }

  /**
   * @param {Record<string, any>} message
   */
  _onCaptureHeader(message) {
    const id = typeof message.id === 'string' && message.id !== '' ? message.id : null;
    const sha256 = typeof message.sha256 === 'string' ? message.sha256.toLowerCase() : '';
    if (!id || !/^[0-9a-f]{64}$/.test(sha256)) {
      this.logger.warn('phone sent a capture header without a usable id/sha256; ignored');
      return;
    }
    const mime = typeof message.mime === 'string' ? message.mime : 'image/png';
    if (mime !== 'image/png') {
      this.logger.warn(`phone announced ${mime}; only image/png is accepted`);
      this.connection.sendText({ type: 'capture-result', id, ok: false, reason: 'unsupported_mime' });
      return;
    }
    const bytes = Number.isInteger(message.bytes) ? message.bytes : 0;
    this.pendingCapture = {
      id,
      sha256,
      arrivedAt: typeof message.arrivedAt === 'string' ? message.arrivedAt : new Date().toISOString(),
      mime,
      bytes,
    };
  }

  /**
   * @param {Record<string, any>} message
   */
  _onChunkHeader(message) {
    if (!this.pendingCapture) {
      this.logger.warn('phone sent a chunk header without a capture header; dropping the transfer');
      this.connection.sendText({
        type: 'capture-result',
        id: typeof message.id === 'string' ? message.id : '',
        ok: false,
        reason: 'incomplete',
      });
      return;
    }
    try {
      this.reassembler.announce(message);
    } catch (err) {
      if (err instanceof ChunkError) {
        this.logger.warn(`chunk rejected: ${err.message}`);
        const id = this.pendingCapture.id;
        this.pendingCapture = null;
        this._abortTransfer();
        this.connection.sendText({ type: 'capture-result', id, ok: false, reason: err.code });
        return;
      }
      throw err;
    }
  }

  /**
   * @param {Buffer} data
   */
  _onBinary(data) {
    this._armSilenceTimer();
    if (!this.pendingCapture) {
      this.logger.warn('phone sent a binary frame with no capture header; dropping it');
      return;
    }
    const capture = this.pendingCapture;

    if (this.reassembler.inProgress) {
      let outcome;
      try {
        outcome = this.reassembler.push(data);
      } catch (err) {
        if (err instanceof ChunkError) {
          this.logger.warn(`chunk body rejected: ${err.message}`);
          this.pendingCapture = null;
          this.connection.sendText({ type: 'capture-result', id: capture.id, ok: false, reason: err.code });
          return;
        }
        throw err;
      }
      if (!outcome.complete) {
        return; // More chunks to come; the header stays pending.
      }
      this.pendingCapture = null;
      void this._acceptPhoneCapture(capture, outcome.data);
      return;
    }

    this.pendingCapture = null;
    void this._acceptPhoneCapture(capture, data);
  }

  /**
   * Validate and store a Phone Capture, then put it on the PC clipboard.
   * @param {{id: string, sha256: string, arrivedAt: string}} capture
   * @param {Buffer} png
   */
  async _acceptPhoneCapture(capture, png) {
    try {
      if (!isPng(png)) {
        // Name the real format. The common case is a phone sending JPEG, because
        // Android screenshots are saved as .jpg; "not a PNG" alone is useless.
        const actual = sniffImageFormat(png);
        this.logger.warn(
          `capture ${capture.id} is ${actual}, not PNG; refused ` +
            `(the Phone must transcode before sending — see PROTOCOL §9)`,
        );
        this.connection.sendText({
          type: 'capture-result',
          id: capture.id,
          ok: false,
          reason: 'not_png',
          detail: `received ${actual}`,
        });
        return;
      }
      const actual = sha256Hex(png);
      if (actual !== capture.sha256) {
        // The Phone computed the hash of what it sent; a mismatch means the
        // bytes were corrupted in flight. Refuse rather than store a lie.
        this.logger.warn(`capture ${capture.id} hash mismatch (claimed ${capture.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
        this.connection.sendText({ type: 'capture-result', id: capture.id, ok: false, reason: 'hash_mismatch' });
        return;
      }
      const { width, height } = tryReadPngSize(png);
      const arrivedAt = new Date();
      const stored = await this.history.addCapture({
        png,
        source: 'phone',
        arrivedAt,
        width,
        height,
      });
      const item = stored.item;
      const duplicate = stored.duplicate;
      if (duplicate) {
        // INVARIANT: a Duplicate is never delivered twice.
        this.logger.info(`capture ${capture.id} is a duplicate of ${item.id}; dropped`);
        this.connection.sendText({ type: 'capture-result', id: capture.id, ok: true });
        this.emit('duplicate', { id: capture.id, existing: item });
        return;
      }

      // PC-side effect: the image becomes the clipboard's content. The helper
      // suppresses its own echo, so this can never come back as a Clipboard
      // Sync message.
      const absolute = this.history.resolveFile(item);
      let onClipboard = false;
      if (absolute) {
        onClipboard = this.helper.setClipboardImage(absolute);
        if (!onClipboard) {
          this.logger.warn('helper unavailable: the capture was stored but not placed on the clipboard');
        }
      } else {
        this.logger.error(`refusing to hand the helper a path outside the history root: ${item.file}`);
      }

      this.connection.sendText({ type: 'capture-result', id: capture.id, ok: true });
      this.emit('capture', { item, direction: 'inbound' });
      // The notification must tell the truth: claiming the image is on the
      // clipboard when the helper could not do it would send the user to a
      // paste that produces nothing.
      this.emit('notify', {
        category: 'captureDelivered',
        title: onClipboard ? '已收到手机截图' : '已收到手机截图（未复制到剪贴板）',
        body: onClipboard
          ? `已存入历史并复制到剪贴板（${width ?? '?'}×${height ?? '?'}）`
          : `已存入历史，但原生助手不可用，未能复制到剪贴板（${width ?? '?'}×${height ?? '?'}）`,
        thumbFile: absolute || undefined,
      });
    } catch (err) {
      this.logger.error('failed to accept a phone capture', { error: /** @type {Error} */ (err).message });
      this.connection.sendText({ type: 'capture-result', id: capture.id, ok: false, reason: 'internal' });
    }
  }

  /**
   * Clipboard Sync inbound (Phone -> PC), PROTOCOL §5.6.
   * @param {Record<string, any>} message
   */
  _onClipboard(message) {
    if (typeof message.text !== 'string') {
      this.logger.warn('phone sent a clipboard message without text; ignored');
      return;
    }
    const text = message.text;
    const verdict = this.echoGuard.inspectInbound(text);
    if (verdict.drop) {
      // THE INVARIANT: our own write must never be treated as a user copy.
      this.logger.debug(`echo suppressed (${verdict.reason}) ${verdict.hash.slice(0, 12)}…`);
      return;
    }
    if (sha256Hex(text) !== (typeof message.sha256 === 'string' ? message.sha256.toLowerCase() : '')) {
      // Not fatal: the sender may have truncated. Trust the text, but say so.
      this.logger.debug('phone clipboard sha256 does not match its text; using the text as-is');
    }
    const truncated = truncateUtf8(text, this.clipboardMaxBytes);
    if (truncated.truncated) {
      this.logger.warn(`inbound clipboard exceeded ${this.clipboardMaxBytes} bytes; truncated`);
    }
    const sent = this.helper.setClipboardText(truncated.text);
    if (!sent) {
      this.logger.warn('helper unavailable: inbound clipboard text was not written to the PC');
      return;
    }
    // Remember our own write so the helper's echo (if it ever leaks one) is
    // swallowed here too.
    this.echoGuard.recordLocalWrite(truncated.text);
    if (this.clipboardLog) {
      this.clipboardLog.record('inbound', truncated.text);
    }
    this.emit('clipboard', { direction: 'inbound', bytes: truncated.bytes, text: truncated.text });
  }

  /** @param {Record<string, any>} message */
  _onCaptureResult(message) {
    const id = String(message.id || '');
    if (!this.awaitingResult) {
      this.logger.debug(`unexpected capture-result for ${id}`);
      return;
    }
    if (this.awaitingResult.id !== id) {
      this.logger.debug(`capture-result for ${id} while waiting for ${this.awaitingResult.id}`);
      return;
    }
    clearTimeout(this.awaitingResult.timer);
    const ok = message.ok === true;
    const { sha256 } = this.awaitingResult;
    this.awaitingResult = null;
    this.delivering = false;
    if (!ok) {
      this.logger.warn(`phone rejected a capture: ${message.reason || 'unknown reason'}`);
    } else {
      // The Phone has it: the Hub may now forget it for replay purposes.
      this.emit('delivered', { id, sha256 });
    }
    this._drainQueue();
  }

  /**
   * Queue a PC Capture for delivery to the Phone.
   *
   * The PNG is buffered rather than re-read from disk so a Retention sweep that
   * runs between enqueue and send cannot pull the file out from under us.
   *
   * @param {Buffer} png
   * @param {Date} [arrivedAt]
   * @returns {boolean} false when the queue was full (the Capture stays in History)
   */
  enqueueCapture(png, arrivedAt = new Date()) {
    if (this.outboundQueue.length >= MAX_QUEUED_CAPTURES) {
      this.logger.warn(
        `outbound capture queue is full (${MAX_QUEUED_CAPTURES}); the capture stays in History and was not sent`,
      );
      return false;
    }
    const size = tryReadPngSize(png);
    this.outboundQueue.push({ png, arrivedAt, width: size.width, height: size.height });
    this._drainQueue();
    return true;
  }

  /** @returns {number} */
  get queuedCaptures() {
    return this.outboundQueue.length;
  }

  _drainQueue() {
    if (this.closed || this.delivering || this.awaitingResult) return;
    if (!this.helloReceived) return; // Wait for the handshake before pushing data.
    const next = this.outboundQueue.shift();
    if (!next) return;
    this.delivering = true;
    this._sendCapture(next);
  }

  /**
   * @param {{png: Buffer, arrivedAt: Date, width: number|null, height: number|null}} capture
   */
  _sendCapture(capture) {
    const sha256 = sha256Hex(capture.png);
    captureSeq += 1;
    // Compact UTC + a per-process sequence: no colons (PROTOCOL §13), and
    // unique even when two Captures arrive in the same millisecond.
    const id = `${compactUtcId(capture.arrivedAt)}-${String(captureSeq).padStart(4, '0')}`;

    this.logger.info(`sending capture ${id} (${capture.png.length} bytes)`, {
      width: capture.width,
      height: capture.height,
    });

    /**
     * 保留 png / arrivedAt / 尺寸的引用，是为了连接在等 ACK 期间断掉时
     * 能把这张图原样塞回队列（见 _onClose）。
     * @type {{id: string, sha256: string, startedAt: number, timer: NodeJS.Timeout,
     *         png: Buffer, arrivedAt: Date, width: number|null, height: number|null}}
     */
    const awaiting = {
      id,
      sha256,
      startedAt: Date.now(),
      png: capture.png,
      arrivedAt: capture.arrivedAt,
      width: capture.width,
      height: capture.height,
      timer: setTimeout(() => {
        if (!this.awaitingResult || this.awaitingResult.id !== id) return;
        this.logger.warn(`no capture-result for ${id} after ${CAPTURE_RESULT_TIMEOUT_MS / 1000}s; moving on`);
        this.awaitingResult = null;
        this.delivering = false;
        this._drainQueue();
      }, CAPTURE_RESULT_TIMEOUT_MS),
    };
    if (typeof awaiting.timer.unref === 'function') awaiting.timer.unref();
    this.awaitingResult = awaiting;

    this.connection.sendText({
      type: 'capture',
      id,
      sha256,
      arrivedAt: wireIso(capture.arrivedAt),
      mime: 'image/png',
      bytes: capture.png.length,
    });

    if (capture.png.length <= SINGLE_FRAME_LIMIT) {
      this.connection.sendBinary(capture.png);
      return;
    }

    // > 1MB: 256KB slices, each announced by a chunk header (PROTOCOL §5.4).
    const total = Math.ceil(capture.png.length / CHUNK_SIZE);
    for (let seq = 0; seq < total; seq += 1) {
      const start = seq * CHUNK_SIZE;
      const slice = capture.png.subarray(start, Math.min(start + CHUNK_SIZE, capture.png.length));
      this.connection.sendText({ type: 'chunk', id, seq, total });
      this.connection.sendBinary(slice);
    }
    this.logger.debug(`capture ${id} sent as ${total} chunk(s)`);
    this.emit('capture-sent', { id, bytes: capture.png.length, total });
  }

  /**
   * Clipboard Sync outbound (PC -> Phone), PROTOCOL §5.6.
   *
   * Called with text a *PC-side* user action produced. The text is remembered as
   * `remoteSend` so that a bounce from the Phone is dropped instead of looping.
   *
   * @param {string} text
   * @returns {{sent: boolean, reason: string|null, bytes: number}}
   */
  sendClipboard(text) {
    if (this.closed) return { sent: false, reason: 'link-down', bytes: 0 };
    const truncated = truncateUtf8(String(text), this.clipboardMaxBytes);
    if (truncated.text.trim() === '') {
      return { sent: false, reason: 'empty', bytes: 0 };
    }
    const echo = this.echoGuard.inspectInbound(truncated.text);
    if (echo.drop) {
      // The PC clipboard event is the echo of a write we made from the Phone.
      this.logger.debug(`outbound clipboard suppressed (${echo.reason})`);
      return { sent: false, reason: `echo:${echo.reason}`, bytes: truncated.bytes };
    }
    const sha256 = sha256Hex(truncated.text);
    this.echoGuard.recordRemoteSend(truncated.text);
    this.connection.sendText({ type: 'clipboard', text: truncated.text, sha256 });
    if (this.clipboardLog) {
      this.clipboardLog.record('outbound', truncated.text);
    }
    this.emit('clipboard', { direction: 'outbound', bytes: truncated.bytes, text: truncated.text });
    return { sent: true, reason: truncated.truncated ? 'truncated' : null, bytes: truncated.bytes };
  }

  _abortTransfer() {
    const aborted = this.reassembler.abort();
    if (aborted) {
      this.logger.warn(`capture ${aborted.id} is incomplete (${aborted.received}/${aborted.total}); discarded`);
    }
  }

  /**
   * @param {number} code
   * @param {string} reason
   */
  _onClose(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closedReason = reason || `close:${code}`;
    if (this._silenceTimer) {
      clearTimeout(this._silenceTimer);
      this._silenceTimer = null;
    }
    if (this.awaitingResult) {
      clearTimeout(this.awaitingResult.timer);
      // 连接在等 ACK 期间断掉 —— 那张图**还没被确认送达**。
      //
      // 早先这里只是丢掉 awaitingResult，于是图永久消失：既没有 delivered
      // 事件（Hub 不会从 pendingOutbound 移除），也没有重新入队，
      // 重连后也不会补发。用户看到的是"电脑截图了，手机没反应"，
      // 而日志里只有一行 ECONNRESET。
      //
      // 现在把它塞回队列头部，重连时优先补发。
      const inflight = this.awaitingResult;
      if (inflight.png) {
        this.outboundQueue.unshift({
          png: inflight.png,
          arrivedAt: inflight.arrivedAt,
          width: inflight.width,
          height: inflight.height,
        });
        this.logger.info(
          `capture ${inflight.id} was in flight when the Link dropped; re-queued for the next connection`,
        );
      }
      this.awaitingResult = null;
      this.delivering = false;
    }
    this._abortTransfer();
    this.logger.info(`Link closed (${code})${reason ? `: ${reason}` : ''}`);
    this.emit('close', { code, reason: this.closedReason, queued: this.outboundQueue.length });
  }

  /**
   * @param {string} reason
   */
  close(reason = 'hub-close') {
    if (this.closed) return;
    this.connection.close(CLOSE_CODE.NORMAL, reason);
    this._onClose(CLOSE_CODE.NORMAL, reason);
  }

  /** Take the parked outbound Captures (used when the Link is replaced). */
  drainQueue() {
    const queued = this.outboundQueue;
    this.outboundQueue = [];
    return queued;
  }
}

/**
 * `arrivedAt` for the wire: ISO-8601 with offset (PROTOCOL §13).
 * @param {Date} date
 * @returns {string}
 */
function wireIso(date) {
  return isoWithOffset(date);
}

module.exports = {
  Link,
  CHUNK_SIZE,
  SINGLE_FRAME_LIMIT,
  CAPTURE_RESULT_TIMEOUT_MS,
  SILENCE_TIMEOUT_MS,
  CLIPBOARD_MAX_BYTES,
  MAX_QUEUED_CAPTURES,
};

