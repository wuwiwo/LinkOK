'use strict';

/**
 * Integration tests: the HTTP surface and its authentication.
 *
 * A real `http.Server` is started on an ephemeral port and driven with `fetch`,
 * because the requirement is about actual wire behaviour (401 bodies, headers,
 * cookies, status codes) and a supertest-style mock would not prove any of it.
 *
 * PROTOCOL.md §2 names exactly three unauthenticated endpoints, and the first
 * test enumerates the whole surface, so a newly added endpoint that forgets its
 * guard fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { Hub } = require('../src/hub');
const { Logger } = require('../src/logger');
const { TempDir, makePng } = require('./helpers');

const VERSION = '0.1.0-test';

/**
 * Boot a Hub on an ephemeral port. The helper is disabled: this suite is about
 * HTTP, and the sandbox cannot spawn the real helper anyway.
 *
 * @param {object} [options]
 */
async function startHub(options = {}) {
  const dir = new TempDir('http');
  const dataDir = options.dataDir || dir.join('data');
  const staticDir = options.staticDir || dir.join('public');
  if (options.withIndex !== false) {
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(
      staticDir + '/index.html',
      '<!doctype html><title>LinkOK test page</title><p>settings</p>',
    );
    fs.writeFileSync(staticDir + '/app.js', 'console.log("linkok");');
    fs.writeFileSync(staticDir + '/styles.css', 'body{color:red}');
  }

  const logger = new Logger({
    logsDir: dir.join('logs'),
    level: 'error',
    stdout: /** @type {any} */ ({ write() {} }),
    fileLogging: false,
  });

  const hub = new Hub({
    dataDir,
    logger,
    version: VERSION,
    staticDir,
    startHelper: false,
  });
  await hub.init();
  const { port } = await hub.listen(0);
  const base = `http://127.0.0.1:${port}`;

  return {
    hub,
    dir,
    port,
    base,
    logger,
    async stop() {
      await hub.shutdown();
      logger.close();
    },
    /** Mint a Token by pairing, as the Phone would. */
    async pair() {
      const minted = hub.pairing.mintCode();
      const response = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: minted.code, deviceName: 'Redmi K50', deviceModel: 'M2012K11AC' }),
      });
      const body = await response.json();
      return { token: body.token, response };
    },
  };
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function get(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  /** @type {any} */
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, text };
}

test('GET /health is public and reports ok, version and paired', async () => {
  const context = await startHub();
  try {
    const result = await get(`${context.base}/health`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, version: VERSION, paired: false });
  } finally {
    await context.stop();
  }
});

test('GET / serves the settings page without authentication', async () => {
  const context = await startHub();
  try {
    const result = await get(`${context.base}/`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get('content-type'), /text\/html/);
    assert.match(result.text, /LinkOK test page/);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await context.stop();
  }
});

test('POST /pair is public and returns a Token for a valid code', async () => {
  const context = await startHub();
  try {
    const minted = context.hub.pairing.mintCode();
    const result = await get(`${context.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: minted.code, deviceName: 'Redmi K50' }),
    });

    assert.equal(result.status, 200);
    assert.match(result.body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(context.hub.pairing.isPaired(), true);
  } finally {
    await context.stop();
  }
});

test('EVERY protected endpoint returns 401 without a Token', async () => {
  const context = await startHub();
  try {
    const protectedRequests = [
      { method: 'GET', path: '/api/state' },
      { method: 'PATCH', path: '/api/config', body: '{}' },
      { method: 'GET', path: '/api/history' },
      { method: 'GET', path: '/api/history/some-id/raw' },
      { method: 'DELETE', path: '/api/history/some-id' },
      { method: 'POST', path: '/api/history/some-id/copy' },
      { method: 'POST', path: '/api/pairing-code' },
      { method: 'POST', path: '/api/device/revoke' },
      { method: 'POST', path: '/api/sync', body: '{"paused":true}' },
      { method: 'POST', path: '/api/reveal', body: '{"target":"storage"}' },
      { method: 'GET', path: '/app.js' },
      { method: 'GET', path: '/styles.css' },
      { method: 'GET', path: '/does-not-exist' },
    ];

    for (const request of protectedRequests) {
      const result = await get(`${context.base}${request.path}`, {
        method: request.method,
        headers: request.body ? { 'Content-Type': 'application/json' } : undefined,
        body: request.body,
      });
      assert.equal(
        result.status,
        401,
        `${request.method} ${request.path} must be 401 without a token, got ${result.status}`,
      );
      assert.equal(result.body.error, 'unauthorized');
      assert.equal(typeof result.body.message, 'string');
    }
  } finally {
    await context.stop();
  }
});

test('a malformed or wrong Bearer token is rejected with 401', async () => {
  const context = await startHub();
  try {
    await context.pair();

    const cases = [
      'Bearer',
      'Bearer ',
      'Basic abc',
      `Bearer ${'a'.repeat(43)}`,
      `Bearer ${'x'}`,
      'Bearer null',
      `bearer wrong`,
    ];
    for (const header of cases) {
      const result = await get(`${context.base}/api/state`, { headers: { Authorization: header } });
      assert.equal(result.status, 401, `"${header}" must be rejected`);
      assert.equal(result.body.error, 'unauthorized');
    }
  } finally {
    await context.stop();
  }
});

test('a valid Bearer token is accepted, case-insensitively on the scheme', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();

    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const result = await get(`${context.base}/api/state`, {
        headers: { Authorization: `${scheme} ${token}` },
      });
      assert.equal(result.status, 200, `${scheme} must be accepted`);
      assert.equal(result.body.paired, true);
    }
  } finally {
    await context.stop();
  }
});

test('GET / sets a session cookie that authenticates /api calls', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();

    const root = await fetch(`${context.base}/`, { redirect: 'manual' });
    const setCookie = root.headers.get('set-cookie');
    assert.ok(setCookie, 'GET / must set the session cookie');
    assert.match(setCookie, /linkok_token=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, new RegExp(`linkok_token=${token}`));

    const cookie = setCookie.split(';')[0];
    const state = await get(`${context.base}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(state.status, 200, 'the page cookie must authenticate API calls');
  } finally {
    await context.stop();
  }
});

test('GET / does not set a cookie when the PC is not paired', async () => {
  const context = await startHub();
  try {
    const root = await fetch(`${context.base}/`);
    assert.equal(root.headers.get('set-cookie'), null, 'there is no Token to hand out');
    await root.text();
  } finally {
    await context.stop();
  }
});

test('an unknown asset 404s instead of returning the page shell', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const result = await get(`${context.base}/nope.js`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, 'not_found');
  } finally {
    await context.stop();
  }
});

test('static assets are served with the right content type', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}` };

    const js = await get(`${context.base}/app.js`, { headers });
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    assert.match(js.text, /linkok/);

    const css = await get(`${context.base}/styles.css`, { headers });
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
  } finally {
    await context.stop();
  }
});

test('directory traversal cannot escape pc/public', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}` };

    const attempts = [
      '/../package.json',
      '/..%2fpackage.json',
      '/%2e%2e/package.json',
      '/....//package.json',
      '/..%5cpackage.json',
      '/%2e%2e%5c%2e%2e%5cpackage.json',
    ];

    for (const path of attempts) {
      const result = await get(`${context.base}${path}`, { headers });
      assert.ok(
        result.status === 404 || result.status === 400,
        `${path} must not be served (got ${result.status})`,
      );
      assert.ok(!result.text.includes('"name"'), `${path} leaked package.json`);
    }
  } finally {
    await context.stop();
  }
});

test('/api/state returns config, connection, helper and paused', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const result = await get(`${context.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } });

    assert.equal(result.status, 200);
    assert.equal(result.body.paired, true);
    assert.equal(result.body.paused, false);
    assert.equal(result.body.version, VERSION);
    assert.equal(result.body.helper.status, 'unavailable', 'the helper is hosted as unavailable, not missing');
    assert.equal(typeof result.body.helper.reason, 'string');
    assert.deepEqual(result.body.connection, { connected: false, deviceName: null, since: null });
    assert.equal(result.body.config.retentionDays, 30);
    assert.equal(typeof result.body.lanAddress, 'string');
  } finally {
    await context.stop();
  }
});

test('PATCH /api/config accepts a valid change and persists it', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const result = await get(`${context.base}/api/config`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ retentionDays: 7, notifications: { clipboardSynced: true } }),
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.retentionDays, 7);
    assert.equal(result.body.notifications.clipboardSynced, true);
    assert.equal(result.body.notifications.enabled, true, 'untouched toggles survive');

    const state = await get(`${context.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(state.body.config.retentionDays, 7);
  } finally {
    await context.stop();
  }
});

test('PATCH /api/config refuses an invalid retentionDays with 400', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    for (const value of [14, -1, 99, '30', null]) {
      const result = await get(`${context.base}/api/config`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ retentionDays: value }),
      });
      assert.equal(result.status, 400, `retentionDays ${JSON.stringify(value)} must be 400`);
      assert.equal(result.body.error, 'invalid_retention_days');
    }
  } finally {
    await context.stop();
  }
});

test('POST /api/pairing-code returns a code, an expiry and a QR payload', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const result = await get(`${context.base}/api/pairing-code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(result.status, 200);
    assert.match(result.body.code, /^[A-Z0-9]{6}$/);
    assert.equal(result.body.expiresAt - Date.now() > 100_000, true, 'the expiry is ~120 s out');
    assert.match(
      result.body.qrPayload,
      /^linkok:\/\/pair\?host=[^&]+&port=\d+&code=[A-Z0-9]{6}&fp=[0-9a-f]{16}$/,
    );
    // The QR payload must not point at a loopback address the phone cannot reach.
    assert.ok(
      !result.body.qrPayload.includes('host=127.0.0.1'),
      'the QR must carry a LAN address, not loopback',
    );
  } finally {
    await context.stop();
  }
});

test('pairing with an expired code is refused', async () => {
  const context = await startHub();
  try {
    const minted = context.hub.pairing.mintCode();
    // Simulate the 120 s elapsing.
    context.hub.pairing.active.expiresAt = Date.now() - 1;

    const result = await get(`${context.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: minted.code }),
    });

    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'no_active_code');
  } finally {
    await context.stop();
  }
});

test('a pairing code is single use over HTTP', async () => {
  const context = await startHub();
  try {
    const minted = context.hub.pairing.mintCode();
    const body = JSON.stringify({ code: minted.code });

    const first = await get(`${context.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const second = await get(`${context.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 401);
    assert.equal(second.body.error, 'no_active_code');
  } finally {
    await context.stop();
  }
});

test('POST /pair without a code is a 400', async () => {
  const context = await startHub();
  try {
    const result = await get(`${context.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'no code' }),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'missing_code');
  } finally {
    await context.stop();
  }
});

test('a non-JSON body is a 400, not a crash', async () => {
  const context = await startHub();
  try {
    const result = await get(`${context.base}/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_json');
  } finally {
    await context.stop();
  }
});

test('POST /api/device/revoke invalidates the Token immediately', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    assert.equal(
      (await get(`${context.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status,
      200,
    );

    const revoked = await get(`${context.base}/api/device/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.ok, true);

    // The old Token must be dead on the very next request.
    const after = await get(`${context.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(after.status, 401, 'the revoked token must stop working at once');

    const health = await get(`${context.base}/health`);
    assert.equal(health.body.paired, false);
  } finally {
    await context.stop();
  }
});

test('POST /api/sync toggles the paused flag', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const paused = await get(`${context.base}/api/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paused: true }),
    });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);

    const state = await get(`${context.base}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(state.body.paused, true);

    const resumed = await get(`${context.base}/api/sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ paused: false }),
    });
    assert.equal(resumed.body.paused, false);
  } finally {
    await context.stop();
  }
});

test('history endpoints return stored items, raw bytes and honour DELETE', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}` };

    const png = makePng({ width: 40, height: 30, seed: 9 });
    const { item } = await context.hub.history.addCapture({ png, source: 'phone' });

    const list = await get(`${context.base}/api/history`, { headers });
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].id, item.id);

    const raw = await fetch(`${context.base}/api/history/${encodeURIComponent(item.id)}/raw`, { headers });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await raw.arrayBuffer());
    assert.ok(bytes.equals(png), 'the raw endpoint must return the exact stored bytes');

    const limited = await get(`${context.base}/api/history?limit=1`, { headers });
    assert.equal(limited.body.items.length, 1);

    const deleted = await get(`${context.base}/api/history/${encodeURIComponent(item.id)}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);

    const after = await get(`${context.base}/api/history`, { headers });
    assert.equal(after.body.items.length, 0);

    const goneRaw = await get(`${context.base}/api/history/${encodeURIComponent(item.id)}/raw`, { headers });
    assert.equal(goneRaw.status, 404);
  } finally {
    await context.stop();
  }
});

test('history filtering by from/to works', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}` };
    const base = Date.now();

    for (let i = 0; i < 3; i += 1) {
      await context.hub.history.addCapture({
        png: makePng({ seed: 200 + i }),
        source: 'phone',
        arrivedAt: new Date(base + i * 3_600_000),
      });
    }

    const from = new Date(base + 1_800_000).toISOString();
    const filtered = await get(`${context.base}/api/history?from=${encodeURIComponent(from)}`, { headers });
    assert.equal(filtered.body.items.length, 2);

    const bad = await get(`${context.base}/api/history?from=not-a-date`, { headers });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_range');
  } finally {
    await context.stop();
  }
});

test('an unknown history id is a 404', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}` };

    const raw = await get(`${context.base}/api/history/nope/raw`, { headers });
    assert.equal(raw.status, 404);

    const deleted = await get(`${context.base}/api/history/nope`, { method: 'DELETE', headers });
    assert.equal(deleted.status, 404);

    const copy = await get(`${context.base}/api/history/nope/copy`, { method: 'POST', headers });
    assert.equal(copy.status, 404);
  } finally {
    await context.stop();
  }
});

test('POST /api/history/:id/copy reports 503 when the helper is unavailable', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const headers = { Authorization: `Bearer ${token}` };

    const { item } = await context.hub.history.addCapture({ png: makePng({ seed: 33 }), source: 'phone' });
    const result = await get(`${context.base}/api/history/${encodeURIComponent(item.id)}/copy`, {
      method: 'POST',
      headers,
    });

    // No helper in this process, so the copy cannot happen — and it must say so
    // rather than pretending to have succeeded.
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'helper_unavailable');
  } finally {
    await context.stop();
  }
});

test('a wrong method on a known path is a 405', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const result = await get(`${context.base}/api/state`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(result.status, 405);
    assert.equal(result.body.error, 'method_not_allowed');
  } finally {
    await context.stop();
  }
});

test('a plain HTTP request to /ws is a 400, not a hang', async () => {
  const context = await startHub();
  try {
    const { token } = await context.pair();
    const result = await get(`${context.base}/ws`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'upgrade_required');
  } finally {
    await context.stop();
  }
});

test('the placeholder page is served when pc/public has no index.html', async () => {
  const context = await startHub({ withIndex: false });
  try {
    const result = await get(`${context.base}/`);
    assert.equal(result.status, 200);
    assert.match(result.text, /LinkOK/);

    // And health still works, so a missing page never blocks the protocol.
    const health = await get(`${context.base}/health`);
    assert.equal(health.status, 200);
  } finally {
    await context.stop();
  }
});
