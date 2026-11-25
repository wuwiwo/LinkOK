'use strict';

/**
 * Minimal RFC 6455 WebSocket server side, no dependencies.
 *
 * LinkOK needs exactly one thing from the WebSocket upgrade: a long-lived
 * authenticated duplex channel to a single Phone (PROTOCOL.md §5, §12). A full
 * WebSocket library would be a dependency for maybe 300 lines of framing, so
 * the Hub implements the subset it uses:
 *
 *  - text frames (JSON control messages), binary frames (image bodies);
 *  - fragmentation, ping/pong control frames, close handshake;
 *  - unmasked frames from the client are a protocol error (close 1002);
 *  - a payload cap so a hostile peer cannot exhaust memory.
 *
 * Outbound writes are queued and respect socket backpressure, because a 20MB
 * Capture is delivered as ~80 frames of 256KB.
 */

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

/** Magic GUID from RFC 6455 §1.3. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

/** Largest single frame the Hub will accept (a chunk is 256KB; 20MB images). */
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Largest reassembled message (one 20MB image plus headroom). */
const DEFAULT_MAX_MESSAGE_BYTES = 21 * 1024 * 1024;

/**
 * @param {string} key value of Sec-WebSocket-Key
 * @returns {string} value of Sec-WebSocket-Accept
 */
function computeAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}${WS_GUID}`)
    .digest('base64');
}

/**
 * Build the HTTP 101 response. Only the fields the Hub actually contradicts
 * (no extensions, no subprotocols) are omitted on purpose.
 * @param {string} key
 * @returns {string}
 */
function handshakeResponse(key) {
  return (
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n` +
    '\r\n'
  );
}

/**
 * Encode one server->client frame (never masked, RFC 6455 §5.1).
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} [fin]
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload, fin = true) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

/**
 * Close status codes used by the Hub.
 */
const CLOSE_CODE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 1002,
  UNSUPPORTED_DATA: 1003,
  POLICY_VIOLATION: 1008,
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
});

class WebSocketConnection extends EventEmitter {
  /**
   * @param {import('node:net').Socket} socket
   * @param {object} [options]
   * @param {number} [options.maxFrameBytes]
   * @param {number} [options.maxMessageBytes]
   */
  constructor(socket, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES } = {}) {
    super();
    this.socket = socket;
    this.maxFrameBytes = maxFrameBytes;
    this.maxMessageBytes = maxMessageBytes;

    this.closed = false;
    this.closeCode = null;
    this.closeReason = '';
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.messagesIn = 0;
    this.messagesOut = 0;
    this.remoteAddress = socket.remoteAddress || null;

    /** @type {Buffer} */
    this._buffer = Buffer.alloc(0);
    /** @type {{opcode:number, chunks:Buffer[], bytes:number}|null} */
    this._fragments = null;
    /** @type {Buffer[]} */
    this._outQueue = [];
    this._draining = false;
    this._writable = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => {
      // A dead peer is normal (WiFi drop). Surface it, then tear down.
      this.emit('error', err);
      this._finalize(CLOSE_CODE.GOING_AWAY, 'socket error');
    });
    socket.on('close', () => this._finalize(this.closeCode, this.closeReason));
  }

  /**
   * @param {Buffer} chunk
   */
  _onData(chunk) {
    if (this.closed) return;
    this.bytesIn += chunk.length;
    this._buffer = this._buffer.length === 0 ? chunk : Buffer.concat([this._buffer, chunk]);
    try {
      this._parseLoop();
    } catch (err) {
      this.emit('error', /** @type {Error} */ (err));
      this._fail(CLOSE_CODE.PROTOCOL_ERROR, 'malformed frame');
    }
  }

  _parseLoop() {
    for (;;) {
      if (this.closed) return;
      const buf = this._buffer;
      if (buf.length < 2) return;

      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLength = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this._fail(CLOSE_CODE.PROTOCOL_ERROR, 'reserved bits set');
        return;
      }
      if (!masked) {
        // RFC 6455 §5.1: every client frame must be masked.
        this._fail(CLOSE_CODE.PROTOCOL_ERROR, 'client frames must be masked');
        return;
      }

      if (payloadLength === 126) {
        if (buf.length < offset + 2) return;
        payloadLength = buf.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          this._fail(CLOSE_CODE.MESSAGE_TOO_BIG, 'frame too large');
          return;
        }
        payloadLength = Number(big);
        offset += 8;
      }

      const isControl = (opcode & 0x08) !== 0;
      if (isControl) {
        if (!fin) {
          this._fail(CLOSE_CODE.PROTOCOL_ERROR, 'fragmented control frame');
          return;
        }
        if (payloadLength > 125) {
          this._fail(CLOSE_CODE.PROTOCOL_ERROR, 'control frame too large');
          return;
        }
      }
      if (payloadLength > this.maxFrameBytes) {
        this._fail(CLOSE_CODE.MESSAGE_TOO_BIG, `frame exceeds ${this.maxFrameBytes} bytes`);
        return;
      }

      const maskOffset = offset;
      if (buf.length < maskOffset + 4 + payloadLength) return;
      const maskKey = buf.subarray(maskOffset, maskOffset + 4);
      const start = maskOffset + 4;
      const payload = Buffer.allocUnsafe(payloadLength);
      for (let i = 0; i < payloadLength; i += 1) {
        payload[i] = buf[start + i] ^ maskKey[i & 3];
      }

      this._buffer = buf.subarray(start + payloadLength);
      this._handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  /**
   * @param {boolean} fin
   * @param {number} opcode
   * @param {Buffer} payload
   */
  _handleFrame(fin, opcode, payload) {
    if (opcode === OPCODE.PING) {
      this._sendFrame(OPCODE.PONG, payload);
      this.emit('ping', payload);
      return;
    }
    if (opcode === OPCODE.PONG) {
      this.emit('pong', payload);
      return;
    }
    if (opcode === OPCODE.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE_CODE.NORMAL;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.closeCode = code;
      this.closeReason = reason;
      // Echo the close frame, then end the TCP stream.
      this._sendFrame(OPCODE.CLOSE, payload);
      this._finalize(code, reason);
      return;
    }

    if (opcode === OPCODE.TEXT || opcode === OPCODE.BINARY) {
      if (!fin) {
        this._fragments = { opcode, chunks: [payload], bytes: payload.length };
        if (this._fragments.bytes > this.maxMessageBytes) {
          this._fail(CLOSE_CODE.MESSAGE_TOO_BIG, 'message too large');
        }
        return;
      }
      this._deliver(opcode, payload);
      return;
    }

    if (opcode === OPCODE.CONTINUATION) {
      if (!this._fragments) {
        this._fail(CLOSE_CODE.PROTOCOL_ERROR, 'unexpected continuation frame');
        return;
      }
      this._fragments.chunks.push(payload);
      this._fragments.bytes += payload.length;
      if (this._fragments.bytes > this.maxMessageBytes) {
        this._fail(CLOSE_CODE.MESSAGE_TOO_BIG, 'message too large');
        return;
      }
      if (fin) {
        const { opcode: original, chunks } = this._fragments;
        this._fragments = null;
        this._deliver(original, Buffer.concat(chunks));
      }
      return;
    }

    this._fail(CLOSE_CODE.PROTOCOL_ERROR, `unknown opcode ${opcode}`);
  }

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  _deliver(opcode, payload) {
    this.messagesIn += 1;
    if (opcode === OPCODE.TEXT) {
      this.emit('text', payload.toString('utf8'));
    } else {
      this.emit('binary', payload);
    }
  }

  /**
   * Queue a text frame. Control messages are JSON (PROTOCOL.md §5.1).
   * @param {string|object} body object is stringified
   */
  sendText(body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    this._sendFrame(OPCODE.TEXT, Buffer.from(text, 'utf8'));
  }

  /**
   * Queue a binary frame (image body or chunk).
   * @param {Buffer} payload
   */
  sendBinary(payload) {
    this._sendFrame(OPCODE.BINARY, payload);
  }

  /**
   * Queue a frame and pump the socket while it accepts writes.
   * @param {number} opcode
   * @param {Buffer} payload
   */
  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const frame = encodeFrame(opcode, payload);
    this.messagesOut += 1;
    this.bytesOut += payload.length;
    this._outQueue.push(frame);
    this._pump();
  }

  _pump() {
    if (this.closed || this._draining) return;
    while (this._outQueue.length > 0) {
      const frame = this._outQueue.shift();
      let ok = false;
      try {
        ok = this.socket.write(frame);
      } catch (err) {
        this.emit('error', /** @type {Error} */ (err));
        this._finalize(CLOSE_CODE.GOING_AWAY, 'write failed');
        return;
      }
      if (!ok) {
        this._draining = true;
        this.socket.once('drain', () => {
          this._draining = false;
          this._pump();
        });
        return;
      }
    }
  }

  /**
   * Graceful close: send a close frame, then half-close the socket once the
   * frame is flushed. `_finalize` runs from the socket 'close' handler, or
   * immediately when the socket is already gone.
   *
   * @param {number} [code]
   * @param {string} [reason]
   */
  close(code = CLOSE_CODE.NORMAL, reason = '') {
    if (this.closed) return;
    this.closeCode = code;
    this.closeReason = reason;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload), () => {
        this.socket.end();
      });
    } catch (err) {
      this.emit('error', /** @type {Error} */ (err));
      this.socket.destroy();
    }
    this._finalize(code, reason);
  }

  /**
   * Protocol-violation close: send the code, destroy shortly after so a stuck
   * peer cannot keep the socket alive.
   * @param {number} code
   * @param {string} reason
   */
  _fail(code, reason) {
    if (this.closed) return;
    this.close(code, reason);
  }

  /**
   * @param {number|null} code
   * @param {string} reason
   */
  _finalize(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this._outQueue.length = 0;
    try {
      if (!this.socket.destroyed) this.socket.destroy();
    } catch {
      // Destroying an already-dead socket is not actionable.
    }
    this.emit('close', code, reason);
  }
}

/**
 * Bind a node:http server's `upgrade` event to the WebSocket layer.
 * The caller is responsible for authentication *before* calling this.
 */
class WebSocketServer {
  constructor() {
    /** @type {WebSocketConnection|null} */
    this.connection = null;
  }

  /**
   * Complete the handshake and start the connection.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head bytes already read from the socket
   * @returns {WebSocketConnection}
   */
  accept(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length === 0) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      throw new Error('missing Sec-WebSocket-Key');
    }
    socket.write(handshakeResponse(key));
    const connection = new WebSocketConnection(socket);
    if (head && head.length > 0) {
      // Bytes that arrived with the upgrade request belong to the WebSocket.
      connection._onData(head);
    }
    this.connection = connection;
    return connection;
  }
}

module.exports = {
  OPCODE,
  CLOSE_CODE,
  WS_GUID,
  WebSocketConnection,
  WebSocketServer,
  computeAcceptKey,
  handshakeResponse,
  encodeFrame,
};
