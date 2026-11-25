'use strict';

/**
 * Integration tests: the WebSocket Link (PROTOCOL.md §5, §12).
 *
 * These drive a real `/ws` endpoint over TCP with a hand-written RFC 6455 client
 * (see `ws-client.js`), because several requirements are about exact bytes:
 * a rejected handshake must not send `Sec-WebSocket-Accept`, >1MB images must
 * arrive as 256KB chunks with `chunk` headers, and a reconnecting Phone must
 * replace the previous connection rather than run alongside it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');

const { Hub } = require('../src/hub');
const { Logger } = require('../src/logger');
const { TestWsClient } = require('./ws-client');
const { TempDir, makePng, makeLargePng, waitFor } = require('./helpers');

const VERSION = '0.1.0-test';

/**
 * @param {object} [options]
 */
async function startHub(options = {}) {
  const dir = new TempDir('ws');
  const staticDir = dir.join('public');
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(`${staticDir}/index.html`, '<!doctype html><title>LinkOK</title>');

  const logger = new Logger({
    logsDir: dir.join('logs'),
    level: 'error',
    stdout: /** @type {any} */ ({ write() {} }),
    fileLogging: false,
  });

  const hub = new Hub({
    dataDir: dir.join('data'),
    logger,
    version: VERSION,
    staticDir,
    startHelper: false,
  });
  await hub.init();
  const { port } = await hub.listen(0);

  return {
    hub,
    dir,
    port,
    logger,
    async stop() {
      await hub.shutdown();
      logger.close();
    },
    /** @param {{token?: string|null}} [opts] */
    async connect(opts = {}) {
      const token = opts.token === undefined ? await pairToken(hub) : opts.token;
      const client = new TestWsClient();
      const handshake = await client.connect({ port, token });
      return { client, handshake };
    },
  };
}

/**
 * @param {Hub} hub
 * @returns {Promise<string>}
 */
async function pairToken(hub) {
  if (hub.pairing.isPaired()) return String(hub.pairing.token);
  const minted = hub.pairing.mintCode();
  const result = hub.pairing.attemptPair(minted.code, { deviceName: 'Redmi K50', deviceModel: 'M2012K11AC' });
  if (!result.ok) throw new Error(`pairing failed: ${result.error}`);
  return result.token;
}

/**
 * @param {TestWsClient} client
 */
async function sayHello(client) {
  client.sendJson({
    type: 'hello',
    deviceName: 'Redmi K50',
    deviceModel: 'M2012K11AC',
    protocolVersion: 1,
  });
  const reply = await client.waitForMessage((message) => message.type === 'hello-ok');
  return reply;
}

test('an unauthenticated handshake is refused with 401 and no Sec-WebSocket-Accept', async () => {
  const context = await startHub();
  try {
    await pairToken(context.hub);

    const client = new TestWsClient();
    const handshake = await client.connect({ port: context.port, token: null });
    client.destroy();

    assert.equal(handshake.status, 401);
    assert.equal(
      handshake.headers['sec-websocket-accept'],
      undefined,
      'a rejected handshake must NOT complete the WebSocket handshake',
    );
  } finally {
    await context.stop();
  }
});

test('a handshake with the wrong Token is refused', async () => {
  const context = await startHub();
  try {
    await pairToken(context.hub);

    const client = new TestWsClient();
    const handshake = await client.connect({ port: context.port, token: 'z'.repeat(43) });
    client.destroy();

    assert.equal(handshake.status, 401);
    assert.equal(handshake.headers['sec-websocket-accept'], undefined);
  } finally {
    await context.stop();
  }
});

test('an authenticated handshake completes and hello-ok follows hello', async () => {
  const context = await startHub();
  try {
    const { client, handshake } = await context.connect();
    assert.equal(handshake.status, 101);
    assert.equal(handshake.headers.upgrade.toLowerCase(), 'websocket');
    assert.equal(typeof handshake.headers['sec-websocket-accept'], 'string');

    const reply = await sayHello(client);
    assert.deepEqual(reply, { type: 'hello-ok', protocolVersion: 1 });
    assert.equal(context.hub.link.deviceName, 'Redmi K50');
    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a Phone Capture is stored, acknowledged, and placed on the clipboard', async () => {
  const context = await startHub();

  // Record what the Hub asks the helper to do, without a real helper.
  const clipboardCalls = [];
  /** @type {any} */ (context.hub.helper).setClipboardImage = (file) => {
    clipboardCalls.push(file);
    return true;
  };

  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makePng({ width: 1080, height: 2400, seed: 5 });
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    client.sendCapture({ id: 'phone-1', sha256, png });

    const result = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(result.id, 'phone-1');
    assert.equal(result.ok, true);

    // Stored in History with the dimensions read from the PNG.
    assert.equal(context.hub.history.count(), 1);
    const [item] = context.hub.history.list();
    assert.equal(item.sha256, sha256);
    assert.equal(item.source, 'phone');
    assert.equal(item.width, 1080);
    assert.equal(item.height, 2400);

    // And handed to the helper as a clipboard image, from History.
    assert.equal(clipboardCalls.length, 1);
    assert.ok(fs.existsSync(clipboardCalls[0]), 'the clipboard file must exist on disk');

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('DUPLICATE: the same image is dropped and never stored twice', async () => {
  const context = await startHub();
  /** @type {any} */ (context.hub.helper).setClipboardImage = () => true;

  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makePng({ seed: 44 });
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');

    client.sendCapture({ id: 'dup-1', sha256, png });
    const first = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(first.ok, true);

    client.sendCapture({ id: 'dup-2', sha256, png });
    const second = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(second.ok, true, 'a duplicate is acknowledged, not errored');
    assert.equal(second.id, 'dup-2');

    assert.equal(context.hub.history.count(), 1, 'the duplicate must not create a second item');
    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a >1MB Capture arriving in 256KB chunks is reassembled byte-for-byte', async () => {
  const context = await startHub();
  /** @type {any} */ (context.hub.helper).setClipboardImage = () => true;

  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makeLargePng(1_400_000);
    assert.ok(png.length > 1024 * 1024);
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');

    client.sendCapture({ id: 'big-1', sha256, png });

    const result = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);

    const [item] = context.hub.history.list();
    assert.equal(item.bytes, png.length, 'the reassembled size must match exactly');

    const stored = fs.readFileSync(context.hub.history.resolveFile(item));
    assert.equal(
      crypto.createHash('sha256').update(stored).digest('hex'),
      sha256,
      'the stored bytes must hash to the original SHA-256',
    );

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a chunk gap causes the whole Capture to be discarded', async () => {
  const context = await startHub();
  /** @type {any} */ (context.hub.helper).setClipboardImage = () => true;

  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makeLargePng(900_000);
    const sha256 = crypto.createHash('sha256').update(png).digest('hex');
    const CHUNK = 256 * 1024;
    const total = Math.ceil(png.length / CHUNK);

    client.sendJson({
      type: 'capture',
      id: 'gap-1',
      sha256,
      arrivedAt: new Date().toISOString(),
      mime: 'image/png',
    });
    // Deliberately skip seq 1.
    for (const seq of [0, 2]) {
      client.sendJson({ type: 'chunk', id: 'gap-1', seq, total });
      client.sendBinary(png.subarray(seq * CHUNK, Math.min((seq + 1) * CHUNK, png.length)));
    }

    const result = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'incomplete');
    assert.equal(context.hub.history.count(), 0, 'an incomplete Capture must not be stored');

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a Capture whose declared hash does not match its bytes is refused', async () => {
  const context = await startHub();
  /** @type {any} */ (context.hub.helper).setClipboardImage = () => true;

  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makePng({ seed: 77 });
    client.sendCapture({ id: 'bad-hash', sha256: 'a'.repeat(64), png });

    const result = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'hash_mismatch');
    assert.equal(context.hub.history.count(), 0);

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a non-PNG body is refused with not_png', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    const notPng = Buffer.from('GIF89a this is definitely not a png');
    const sha256 = crypto.createHash('sha256').update(notPng).digest('hex');
    client.sendCapture({ id: 'not-png', sha256, png: notPng });

    const result = await client.waitForMessage((message) => message.type === 'capture-result');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_png');

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('ping is answered with pong', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    client.sendJson({ type: 'ping' });
    const pong = await client.waitForMessage((message) => message.type === 'pong');
    assert.deepEqual(pong, { type: 'pong' });

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('ECHO: clipboard text the Hub wrote itself is not sent back to the Phone', async () => {
  const context = await startHub();
  const written = [];
  /** @type {any} */ (context.hub.helper).setClipboardText = (text) => {
    written.push(text);
    return true;
  };

  try {
    const { client } = await context.connect();
    await sayHello(client);

    // The Phone sends a value; the Hub writes it locally.
    client.sendJson({ type: 'clipboard', text: 'value from the phone', sha256: crypto.createHash('sha256').update('value from the phone').digest('hex') });
    await waitFor(() => written.length === 1, { what: 'the local clipboard write' });

    // Now the PC-side clipboard notification for that same write arrives (this
    // is what the helper's echo would look like if it ever leaked one).
    context.hub._onHelperClipboardText({ text: 'value from the phone' });

    // Nothing must be pushed to the Phone: that would be the loop.
    const frame = await client.nextFrame(300);
    assert.equal(frame, null, 'the Hub must not echo its own clipboard write back to the Phone');

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('clipboard text from the PC is sent to the Phone', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    context.hub._onHelperClipboardText({ text: 'copied on the PC' });

    const message = await client.waitForMessage((entry) => entry.type === 'clipboard');
    assert.equal(message.text, 'copied on the PC');
    assert.equal(message.sha256, crypto.createHash('sha256').update('copied on the PC').digest('hex'));

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('ECHO: a bounce of something the Hub sent is dropped', async () => {
  const context = await startHub();
  const written = [];
  /** @type {any} */ (context.hub.helper).setClipboardText = (text) => {
    written.push(text);
    return true;
  };

  try {
    const { client } = await context.connect();
    await sayHello(client);

    context.hub._onHelperClipboardText({ text: 'bounced value' });
    await client.waitForMessage((entry) => entry.type === 'clipboard');

    // The Phone failed to suppress its own echo and sends it straight back.
    client.sendJson({
      type: 'clipboard',
      text: 'bounced value',
      sha256: crypto.createHash('sha256').update('bounced value').digest('hex'),
    });

    // Give the message time to arrive and be rejected.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(written.length, 0, 'the bounce must not be written to the PC clipboard');

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('SINGLE CONNECTION: a new Link closes the old one with 1000', async () => {
  const context = await startHub();
  try {
    const token = await pairToken(context.hub);

    const first = new TestWsClient();
    await first.connect({ port: context.port, token });
    await sayHello(first);

    const second = new TestWsClient();
    await second.connect({ port: context.port, token });
    await sayHello(second);

    const closed = await first.waitForClose(3000);
    assert.equal(closed.closed, true, 'the previous Link must be closed');
    assert.equal(closed.code, 1000, 'PROTOCOL §12 requires a normal close (1000)');

    // And the new one is the live Link.
    assert.equal(context.hub.link.deviceName, 'Redmi K50');

    second.destroy();
  } finally {
    await context.stop();
  }
});

test('a PC Capture is delivered to the Phone as a capture + binary frame', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makePng({ width: 800, height: 600, seed: 6 });
    await context.hub._ingestHelperFile(
      { file: writeTemp(context, 'pc-shot.png', png) },
      'pc-folder',
    );

    const header = await client.waitForMessage((message) => message.type === 'capture');
    assert.equal(header.mime, 'image/png');
    assert.equal(header.bytes, png.length);
    assert.equal(header.sha256, crypto.createHash('sha256').update(png).digest('hex'));
    assert.match(header.id, /^\d{8}T\d{9}-\d{4}$/, 'the outbound id must be colon-free');

    const binary = await client.nextFrame();
    assert.equal(binary.type, 'binary');
    assert.ok(binary.payload.equals(png), 'the binary frame must carry the exact PNG');

    // Delivery is serial: the Hub waits for capture-result.
    client.sendJson({ type: 'capture-result', id: header.id, ok: true });

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a PC Capture >1MB is delivered as chunk headers plus 256KB binary frames', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    const png = makeLargePng(1_400_000);
    await context.hub._ingestHelperFile({ file: writeTemp(context, 'big-pc.png', png) }, 'pc-folder');

    const header = await client.waitForMessage((message) => message.type === 'capture');
    assert.equal(header.bytes, png.length);

    /** @type {Buffer[]} */
    const parts = [];
    let total = null;
    let seq = 0;
    for (;;) {
      const frame = await client.nextFrame(4000);
      assert.ok(frame, 'expected a chunk header');
      if (frame.type === 'text') {
        const message = JSON.parse(frame.payload.toString('utf8'));
        assert.equal(message.type, 'chunk');
        assert.equal(message.id, header.id);
        assert.equal(message.seq, seq);
        if (total === null) total = message.total;
        assert.equal(message.total, total);
        const body = await client.nextFrame(4000);
        assert.equal(body.type, 'binary');
        assert.ok(body.payload.length <= 256 * 1024, 'each chunk must be at most 256KB');
        parts.push(body.payload);
        seq += 1;
        if (seq === total) break;
      }
    }

    const reassembled = Buffer.concat(parts);
    assert.ok(reassembled.equals(png), 'the chunked delivery must reassemble to the original PNG');
    assert.equal(total, Math.ceil(png.length / (256 * 1024)));

    client.sendJson({ type: 'capture-result', id: header.id, ok: true });
    client.destroy();
  } finally {
    await context.stop();
  }
});

test('delivery is serial: a second Capture waits for the first capture-result', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    const first = makePng({ seed: 301 });
    const second = makePng({ seed: 302 });
    await context.hub._ingestHelperFile({ file: writeTemp(context, 'a.png', first) }, 'pc-folder');
    await context.hub._ingestHelperFile({ file: writeTemp(context, 'b.png', second) }, 'pc-folder');

    const headerOne = await client.waitForMessage((message) => message.type === 'capture');
    await client.nextFrame(); // its binary body

    // Without acknowledging, the second Capture must NOT be sent (PROTOCOL §12).
    const tooEarly = await client.nextFrame(400);
    assert.equal(tooEarly, null, 'a second capture must not start before the first is acknowledged');

    client.sendJson({ type: 'capture-result', id: headerOne.id, ok: true });
    const headerTwo = await client.waitForMessage((message) => message.type === 'capture');
    assert.notEqual(headerTwo.id, headerOne.id);

    client.sendJson({ type: 'capture-result', id: headerTwo.id, ok: true });
    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a PC Capture made while the Phone is away is parked and sent on reconnect', async () => {
  const context = await startHub();
  const token = await pairToken(context.hub);

  try {
    // No Link at all: the Capture must go to History and wait.
    const png = makePng({ seed: 401 });
    await context.hub._ingestHelperFile({ file: writeTemp(context, 'parked.png', png) }, 'pc-folder');
    assert.equal(context.hub.history.count(), 1, 'the Capture must be safe in History');

    // Now the Phone connects.
    const client = new TestWsClient();
    await client.connect({ port: context.port, token });
    await sayHello(client);

    const header = await client.waitForMessage((message) => message.type === 'capture');
    assert.equal(header.sha256, crypto.createHash('sha256').update(png).digest('hex'));
    await client.nextFrame();

    client.sendJson({ type: 'capture-result', id: header.id, ok: true });
    client.destroy();
  } finally {
    await context.stop();
  }
});

test('an unmasked client frame is a protocol violation and closes the link', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    client.sendUnmaskedText('{"type":"ping"}');

    const closed = await client.waitForClose(3000);
    assert.equal(closed.closed, true, 'an unmasked frame must close the connection');
    assert.equal(closed.code, 1002, 'RFC 6455 requires 1002 for a protocol error');

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('a clean client close is acknowledged', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    client.sendClose(1000, 'bye');
    const closed = await client.waitForClose(3000);
    assert.equal(closed.closed, true);

    await waitFor(() => context.hub.link === null, { what: 'the Hub to notice the Link is gone' });
    client.destroy();
  } finally {
    await context.stop();
  }
});

test('malformed JSON from the Phone is ignored without dropping the Link', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    client.sendRawText('{ this is not json }');
    client.sendRawText('{"no_type":true}');

    // The Link must still answer.
    client.sendJson({ type: 'ping' });
    const pong = await client.waitForMessage((message) => message.type === 'pong');
    assert.deepEqual(pong, { type: 'pong' });

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('an unknown message type is ignored', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    client.sendJson({ type: 'video-stream', payload: 'nope' });
    client.sendJson({ type: 'ping' });

    const pong = await client.waitForMessage((message) => message.type === 'pong');
    assert.deepEqual(pong, { type: 'pong' });

    client.destroy();
  } finally {
    await context.stop();
  }
});

test('capture-header bytes over 20MB is not silently accepted', async () => {
  const context = await startHub();
  try {
    const { client } = await context.connect();
    await sayHello(client);

    // The Hub must not buffer an unbounded body: a frame cap rejects it.
    const huge = Buffer.alloc(9 * 1024 * 1024, 0x41);
    client.sendCapture({
      id: 'huge',
      sha256: crypto.createHash('sha256').update(huge).digest('hex'),
      png: huge,
    });

    // Either the frame cap closes the link (1009) or the capture is refused;
    // both are acceptable, silently accepting it is not.
    const outcome = await Promise.race([
      client.waitForClose(3000),
      client.waitForMessage((message) => message.type === 'capture-result', 3000).then(() => ({ closed: false })),
    ]);
    if (!outcome.closed) {
      assert.equal(context.hub.history.count(), 0, 'an oversized body must not be stored');
    }
    client.destroy();
  } finally {
    await context.stop();
  }
});

/**
 * @param {{dir: TempDir}} context
 * @param {string} name
 * @param {Buffer} bytes
 * @returns {string}
 */
function writeTemp(context, name, bytes) {
  const file = context.dir.join(name);
  fs.writeFileSync(file, bytes);
  return file;
}
