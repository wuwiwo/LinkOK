'use strict';

/**
 * A byte-level WebSocket client for tests.
 *
 * The Hub's `/ws` handshake must reject an unauthenticated upgrade *without*
 * sending `Sec-WebSocket-Accept` (PROTOCOL.md §5). A high-level client hides
 * exactly that detail, and Node's built-in `WebSocket` cannot set an
 * `Authorization` header without undici-specific extensions. Speaking RFC 6455
 * directly on a `net.Socket` tests the real bytes and costs ~120 lines.
 */

const net = require('node:net');
const crypto = require('node:crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {string} key
 * @returns {string}
 */
function acceptFor(key) {
  return crypto.createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

class TestWsClient {
  constructor() {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    /** @type {Array<{type: 'text'|'binary'|'close', payload: Buffer}>} */
    this.frames = [];
    this.handshake = null;
    this.closed = false;
    this.closeCode = null;
    this.closeReason = '';
    this._waiters = [];
  }

  /**
   * Perform the HTTP upgrade. Resolves with the parsed response head, whether it
   * succeeded (101) or not (401/400).
   *
   * @param {object} options
   * @param {number} options.port
   * @param {string} [options.path]
   * @param {string|null} [options.token] omitted entirely when null
   * @param {string} [options.host]
   * @returns {Promise<{status: number, headers: Record<string,string>}>}
   */
  async connect({ port, path = '/ws', token = null, host = '127.0.0.1' }) {
    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.createConnection({ port, host });
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('close', () => {
      this.closed = true;
      this._wake();
      if (this._headResolve) this._headResolve(null);
    });
    this.socket.on('error', () => {
      this.closed = true;
      this._wake();
      if (this._headResolve) this._headResolve(null);
    });

    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });

    const headers = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (token !== null) headers.push(`Authorization: Bearer ${token}`);

    const headPromise = new Promise((resolve) => {
      this._headResolve = resolve;
    });
    this.socket.write(`${headers.join('\r\n')}\r\n\r\n`);

    const head = await Promise.race([
      headPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
    this._headResolve = null;
    if (!head) throw new Error('handshake timed out');
    this.handshake = head;
    return head;
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (!this.handshake) {
      const index = this.buffer.indexOf('\r\n\r\n');
      if (index === -1) return;
      const rawHead = this.buffer.subarray(0, index).toString('latin1');
      this.buffer = this.buffer.subarray(index + 4);
      const [statusLine, ...headerLines] = rawHead.split('\r\n');
      const status = Number.parseInt(statusLine.split(' ')[1] || '0', 10);
      /** @type {Record<string,string>} */
      const parsed = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        parsed[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const head = { status, headers: parsed };
      this.handshake = head;
      if (this._headResolve) this._headResolve(head);
      if (status !== 101) {
        // Nothing else will arrive on a rejected upgrade.
        return;
      }
    }

    this._parseFrames();
  }

  _parseFrames() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x1) this.frames.push({ type: 'text', payload });
      else if (opcode === 0x2) this.frames.push({ type: 'binary', payload });
      else if (opcode === 0x8) {
        this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        this.frames.push({ type: 'close', payload });
      } else if (opcode === 0x9) this._writeFrame(0xa, payload);
      this._wake();
    }
  }

  /** @param {number} opcode @param {Buffer} payload */
  _writeFrame(opcode, payload) {
    if (!this.socket || this.socket.destroyed) return;
    const mask = crypto.randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /** @param {object|string} message */
  sendJson(message) {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    this._writeFrame(0x1, Buffer.from(text, 'utf8'));
  }

  /** @param {string} raw */
  sendRawText(raw) {
    this._writeFrame(0x1, Buffer.from(raw, 'utf8'));
  }

  /** @param {Buffer} data */
  sendBinary(data) {
    this._writeFrame(0x2, data);
  }

  /** @param {number} [code] @param {string} [reason] */
  sendClose(code = 1000, reason = '') {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this._writeFrame(0x8, payload);
  }

  /** Send an unmasked frame, which a compliant server must reject. */
  sendUnmaskedText(text) {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length & 0x7f;
    this.socket.write(Buffer.concat([header, payload]));
  }

  _wake() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Read the next frame, or null on timeout.
   * @param {number} [timeoutMs]
   * @returns {Promise<{type: 'text'|'binary'|'close', payload: Buffer}|null>}
   */
  async nextFrame(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.frames.length > 0) return this.frames.shift();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 50));
        this._waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /**
   * Read frames until one is text JSON satisfying `predicate`.
   * @param {(message: any) => boolean} predicate
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} the matching parsed message
   */
  async waitForMessage(predicate, timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    /** @type {any[]} */
    const seen = [];
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`no matching message; saw ${JSON.stringify(seen.map((m) => m && m.type))}`);
      }
      const frame = await this.nextFrame(remaining);
      if (!frame) {
        throw new Error(`no matching message; saw ${JSON.stringify(seen.map((m) => m && m.type))}`);
      }
      if (frame.type !== 'text') continue;
      const message = JSON.parse(frame.payload.toString('utf8'));
      seen.push(message);
      if (predicate(message)) return message;
    }
  }

  /** @param {number} [timeoutMs] */
  async nextJson(timeoutMs = 3000) {
    return this.waitForMessage(() => true, timeoutMs);
  }

  /**
   * Send a complete Capture (header + body, with chunking above 1MB).
   * @param {object} options
   * @param {string} options.id
   * @param {string} options.sha256
   * @param {Buffer} options.png
   */
  sendCapture({ id, sha256, png }) {
    this.sendJson({
      type: 'capture',
      id,
      sha256,
      arrivedAt: new Date().toISOString(),
      mime: 'image/png',
      bytes: png.length,
    });
    if (png.length <= 1024 * 1024) {
      this.sendBinary(png);
      return;
    }
    const chunkSize = 256 * 1024;
    const total = Math.ceil(png.length / chunkSize);
    for (let seq = 0; seq < total; seq += 1) {
      this.sendJson({ type: 'chunk', id, seq, total });
      this.sendBinary(png.subarray(seq * chunkSize, Math.min((seq + 1) * chunkSize, png.length)));
    }
  }

  /** @param {number} [timeoutMs] */
  async waitForClose(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { closed: this.closed, code: this.closeCode, reason: this.closeReason };
  }

  destroy() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.closed = true;
  }
}

module.exports = { TestWsClient, acceptFor };
