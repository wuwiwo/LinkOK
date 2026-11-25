'use strict';

/**
 * End-to-end smoke check against a *running* Hub process.
 *
 * This is deliberately separate from `test/`: it is not a unit test, it is the
 * acceptance check that the documented startup path actually works. It pairs
 * with a real Token, opens a real WebSocket, pushes a real capture, and prints
 * what it saw. Run it while the Hub is up:
 *
 *   node test/smoke.js http://127.0.0.1:8787
 *
 * It is safe against a live Hub: it only adds one Capture per run and never
 * deletes anything.
 */

const crypto = require('node:crypto');
const http = require('node:http');

/**
 * @param {string} base
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function call(base, path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  /** @type {any} */
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

/**
 * Minimal PNG so the Hub's IHDR check and the clipboard both accept it.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function makePng(width, height) {
  const zlib = require('node:zlib');
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuffer = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([length, typeBuffer, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height, 0x33);
  for (let y = 0; y < height; y += 1) raw[y * rowBytes] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  const base = process.argv[2] || 'http://127.0.0.1:8787';
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  };

  // 1. health
  const health = await call(base, '/health');
  record('GET /health', health.status === 200 && health.body.ok === true, JSON.stringify(health.body));

  // 2. unauthenticated state must 401
  const unauthorized = await call(base, '/api/state');
  record('GET /api/state without a token is 401', unauthorized.status === 401, `status ${unauthorized.status}`);

  // 3. the settings page
  const root = await call(base, '/');
  record('GET / serves settings HTML', root.status === 200 && typeof root.body === 'string', `${String(root.body).length} bytes`);

  // 4. pairing needs a code that only the PC can see. The smoke check cannot
  //    read it from the process, so it asks the operator to paste one.
  const code = process.argv[3] || process.env.LINKOK_PAIR_CODE;
  if (!code) {
    record('pairing', false, 'skipped: pass a pairing code as the second argument or LINKOK_PAIR_CODE');
  } else {
    const paired = await call(base, '/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName: 'smoke-test', deviceModel: 'node' }),
    });
    const token = paired.body && paired.body.token;
    record('POST /pair', paired.status === 200 && typeof token === 'string', `status ${paired.status}`);

    if (token) {
      // 5. authenticated state
      const state = await call(base, '/api/state', { headers: { Authorization: `Bearer ${token}` } });
      record('GET /api/state with a token', state.status === 200, `helper=${state.body.helper.status}`);

      // 6. retention validation
      const badConfig = await call(base, '/api/config', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ retentionDays: 99 }),
      });
      record('PATCH /api/config rejects 99', badConfig.status === 400, badConfig.body.error);

      // 7. WebSocket handshake + capture round trip
      await wsCapture(base, token, record);

      // 8. history contains what we just pushed
      const history = await call(base, '/api/history?limit=5', { headers: { Authorization: `Bearer ${token}` } });
      const items = (history.body && history.body.items) || [];
      record('GET /api/history', history.status === 200 && items.length > 0, `${items.length} item(s)`);
    }
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) process.exitCode = 1;
}

/**
 * Open a real WebSocket and push one Capture, then wait for capture-result.
 * @param {string} base
 * @param {string} token
 * @param {(name: string, ok: boolean, detail?: string) => void} record
 */
function wsCapture(base, token, record) {
  return new Promise((resolve) => {
    const url = new URL(base);
    const key = crypto.randomBytes(16).toString('base64');
    const socket = require('node:net').createConnection({
      host: url.hostname,
      port: Number(url.port) || 80,
    });

    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const png = makePng(48, 32);
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    const id = `smoke-${Date.now()}`;
    const timer = setTimeout(() => {
      record('WebSocket capture round trip', false, 'timed out');
      socket.destroy();
      resolve();
    }, 8000);

    const sendFrame = (opcode, payload) => {
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
      header[0] = 0x80 | opcode;
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3];
      socket.write(Buffer.concat([header, mask, masked]));
    };
    const sendJson = (message) => sendFrame(0x1, Buffer.from(JSON.stringify(message), 'utf8'));

    socket.on('connect', () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: ${url.hostname}:${url.port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          `Authorization: Bearer ${token}`,
          '',
          '',
        ].join('\r\n'),
      );
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const index = buffer.indexOf('\r\n\r\n');
        if (index === -1) return;
        const head = buffer.subarray(0, index).toString('latin1');
        buffer = buffer.subarray(index + 4);
        if (!head.startsWith('HTTP/1.1 101')) {
          record('WebSocket handshake', false, head.split('\r\n')[0]);
          clearTimeout(timer);
          socket.destroy();
          resolve();
          return;
        }
        record('WebSocket handshake', true, '101 Switching Protocols');
        upgraded = true;
        sendJson({ type: 'hello', deviceName: 'smoke', deviceModel: 'node', protocolVersion: 1 });
      }

      for (;;) {
        if (buffer.length < 2) return;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffer.length < offset + length) return;
        const opcode = buffer[0] & 0x0f;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);

        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString('utf8'));
        if (message.type === 'hello-ok') {
          sendJson({ type: 'capture', id, sha256, arrivedAt: new Date().toISOString(), mime: 'image/png', bytes: png.length });
          sendFrame(0x2, png);
        } else if (message.type === 'capture-result' && message.id === id) {
          record('WebSocket capture round trip', message.ok === true, `ok=${message.ok} reason=${message.reason || '-'}`);
          clearTimeout(timer);
          socket.destroy();
          resolve();
        }
      }
    });

    socket.on('error', (err) => {
      record('WebSocket capture round trip', false, err.message);
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((err) => {
  process.stderr.write(`smoke check crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});
