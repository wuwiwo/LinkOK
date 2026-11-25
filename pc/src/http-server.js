'use strict';

/**
 * HTTP surface of the Hub (PROTOCOL.md §3).
 *
 * Authentication lives in one place (`authorize`) so that "only three endpoints
 * are unauthenticated" is checkable by reading a single switch. Everything else
 * is 401 with the documented body.
 *
 * The settings page is served from `pc/public/` and needs a credential for its
 * own `fetch('/api/…')` calls. Browsers cannot attach an Authorization header to
 * a plain navigation or an `<img src>`, so `GET /` (and only that path) also
 * sets an HttpOnly session cookie carrying the same Token. That keeps one
 * credential, one comparison path, and no token in the URL.
 */

const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { constantTimeEquals, fingerprintOf } = require('./crypto-util');
const { resolveStaticPath, sendStaticFile, sendPlaceholderPage } = require('./static');
const { WebSocketServer } = require('./ws');
const { toDate } = require('./time');

/** Only these three are unauthenticated (PROTOCOL §2). */
const PUBLIC_ROUTES = Object.freeze([
  { method: 'GET', path: '/health' },
  { method: 'POST', path: '/pair' },
  { method: 'GET', path: '/' },
]);

const COOKIE_NAME = 'linkok_token';
const MAX_BODY_BYTES = 1024 * 1024;

/** @typedef {import('./link').Link} Link */
/** @typedef {import('./config').ConfigStore} ConfigStore */
/** @typedef {import('./history-store').HistoryStore} HistoryStore */
/** @typedef {import('./pairing').PairingService} PairingService */
/** @typedef {import('./helper-supervisor').HelperSupervisor} HelperSupervisor */
/** @typedef {import('./logger').Logger} Logger */

class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string,string>} [headers]
 */
function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(payload.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string,string>} [headers]
 */
function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { error: code, message }, headers);
}

/**
 * Parse an RFC 6265 Cookie header into a plain object.
 * @param {string|undefined} header
 * @returns {Record<string,string>}
 */
function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '' && !(name in out)) out[name] = value;
  }
  return out;
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<unknown>}
 */
function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new HttpError(413, 'body_too_large', `请求体超过 ${limit} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => reject(err));
    req.on('end', () => {
      if (total === 0) {
        resolve({});
        return;
      }
      const text = Buffer.concat(chunks, total).toString('utf8');
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(new HttpError(400, 'invalid_json', '请求体不是合法的 JSON'));
      }
    });
  });
}

class HttpServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {ConfigStore} options.configStore
   * @param {PairingService} options.pairing
   * @param {HistoryStore} options.history
   * @param {HelperSupervisor} options.helper
   * @param {Logger} options.logger
   * @param {string} options.staticDir absolute `pc/public`
   * @param {() => Link|null} options.getLink
   * @param {() => boolean} [options.isPaused]
   * @param {(paused: boolean) => Promise<void>} [options.setPaused]
   * @param {string} options.version
   * @param {() => string} [options.lanAddress]
   * @param {(file: string) => void} [options.revealInExplorer]
   * @param {any} [options.qrcode] injectable QR library (defaults to `qrcode`)
   * @param {import('./clipboard-log').ClipboardLog} [options.clipboardLog]
   */
  constructor({
    configStore,
    pairing,
    history,
    helper,
    logger,
    staticDir,
    getLink,
    isPaused = () => false,
    setPaused = null,
    version,
    lanAddress,
    revealInExplorer = null,
    qrcode = null,
    clipboardLog = null,
  }) {
    super();
    this.configStore = configStore;
    this.pairing = pairing;
    this.history = history;
    this.helper = helper;
    this.logger = logger;
    this.staticDir = path.resolve(staticDir);
    this.clipboardLog = clipboardLog;
    this.getLink = getLink;
    this.isPaused = isPaused;
    this.setPaused = setPaused;
    this.version = version;
    this.lanAddress = lanAddress || (() => '127.0.0.1');
    this.revealInExplorer = revealInExplorer;
    this.qrcode = qrcode;

    this.wsServer = new WebSocketServer();
    /** @type {http.Server|null} */
    this.server = null;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean} true when the request carries a valid Token
   */
  isAuthorized(req) {
    const expected = this.pairing.token;
    if (!expected) return false;

    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (match && constantTimeEquals(match[1].trim(), expected)) return true;
    }
    // Same-origin convenience for the settings page (GET / sets it).
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[COOKIE_NAME] && constantTimeEquals(cookies[COOKIE_NAME], expected)) return true;
    return false;
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {URL} url
   * @returns {boolean}
   */
  isPublicRoute(req, url) {
    const method = (req.method || 'GET').toUpperCase();
    if (url.pathname === '/' && (method === 'GET' || method === 'HEAD')) return true;
    if (url.pathname === '/health' && method === 'GET') return true;
    if (url.pathname === '/pair' && method === 'POST') return true;
    return false;
  }

  /**
   * @param {number} port
   * @param {string} host
   * @returns {Promise<{port: number, host: string}>}
   */
  listen(port, host) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handle(req, res).catch((err) => {
          this._onUnhandled(req, res, err);
        });
      });
      server.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
      server.on('clientError', (err, socket) => {
        // Malformed TLS on a plaintext port, port scanners, and so on.
        this.logger.debug(`client error: ${err.message}`);
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      });
      server.on('error', (err) => {
        reject(err);
      });
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        server.on('error', (err) => {
          this.logger.error('http server error', { error: err.message });
        });
        this.server = server;
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        resolve({ port: actualPort, host });
      });
    });
  }

  async close() {
    if (this.wsServer.connection && !this.wsServer.connection.closed) {
      this.wsServer.connection.close(1001, 'hub-shutdown');
    }
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handle(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/ws') {
      // A plain HTTP request to /ws is a client bug, not an upgrade.
      sendError(res, 400, 'upgrade_required', '请使用 WebSocket 连接到 /ws');
      return;
    }

    if (!this.isPublicRoute(req, url) && !this.isAuthorized(req)) {
      sendError(res, 401, 'unauthorized', '未授权的请求');
      return;
    }

    const method = (req.method || 'GET').toUpperCase();

    try {
      if (url.pathname === '/health') {
        this._handleHealth(res, method);
        return;
      }
      if (url.pathname === '/pair') {
        await this._handlePair(req, res);
        return;
      }
      if (url.pathname === '/') {
        await this._handleRoot(req, res, method);
        return;
      }
      if (url.pathname === '/api/state') {
        this._requireMethod(method, 'GET');
        this._handleState(res);
        return;
      }
      if (url.pathname === '/api/config') {
        this._requireMethod(method, 'PATCH');
        await this._handlePatchConfig(req, res);
        return;
      }
      if (url.pathname === '/api/history') {
        this._requireMethod(method, 'GET');
        this._handleHistoryList(res, url);
        return;
      }
      if (url.pathname === '/api/clipboard') {
        this._requireMethod(method, 'GET');
        this._handleClipboardLog(res, url);
        return;
      }
      if (url.pathname === '/api/pairing-code') {
        this._requireMethod(method, 'POST');
        await this._handlePairingCode(res);
        return;
      }
      if (url.pathname === '/api/device/revoke') {
        this._requireMethod(method, 'POST');
        this._handleRevoke(res);
        return;
      }
      if (url.pathname === '/api/sync') {
        this._requireMethod(method, 'POST');
        await this._handleSync(req, res);
        return;
      }
      if (url.pathname === '/api/reveal') {
        this._requireMethod(method, 'POST');
        await this._handleReveal(req, res);
        return;
      }

      const rawMatch = /^\/api\/history\/([^/]+)\/raw$/.exec(url.pathname);
      if (rawMatch) {
        this._requireMethod(method, 'GET');
        await this._handleHistoryRaw(res, decodeURIComponent(rawMatch[1]));
        return;
      }
      const copyMatch = /^\/api\/history\/([^/]+)\/copy$/.exec(url.pathname);
      if (copyMatch) {
        this._requireMethod(method, 'POST');
        this._handleHistoryCopy(res, decodeURIComponent(copyMatch[1]));
        return;
      }
      const deleteMatch = /^\/api\/history\/([^/]+)$/.exec(url.pathname);
      if (deleteMatch) {
        this._requireMethod(method, 'DELETE');
        await this._handleHistoryDelete(res, decodeURIComponent(deleteMatch[1]));
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const file = resolveStaticPath(url.pathname, this.staticDir);
        if (file && sendStaticFile(res, file, { headOnly: method === 'HEAD' })) return;
        // Only `/` gets the placeholder: an unknown asset must 404 so the page
        // notices instead of rendering HTML where it expected JS.
        if (url.pathname === '/') {
          sendPlaceholderPage(res);
          return;
        }
      }

      sendError(res, 404, 'not_found', '资源不存在');
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err.status, err.code, err.message);
        return;
      }
      throw err;
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {unknown} err
   */
  _onUnhandled(req, res, err) {
    this.logger.error(`unhandled error for ${req.method} ${req.url}`, {
      error: /** @type {Error} */ (err).message,
      stack: /** @type {Error} */ (err).stack,
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendError(res, 500, 'internal_error', '服务器内部错误');
  }

  /**
   * @param {string} method
   * @param {string} expected
   */
  _requireMethod(method, expected) {
    if (method !== expected) {
      throw new HttpError(405, 'method_not_allowed', `该端点只接受 ${expected}`);
    }
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   */
  _handleHealth(res, method) {
    if (method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', '该端点只接受 GET');
    }
    sendJson(res, 200, { ok: true, version: this.version, paired: this.pairing.isPaired() });
  }

  /**
   * `GET /` — the settings page shell, plus the session cookie.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   */
  async _handleRoot(req, res, method) {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', '该端点只接受 GET');
    }
    const token = this.pairing.token;
    if (token) {
      // The page's own fetch() calls authenticate with this cookie; it is
      // HttpOnly so page JS cannot exfiltrate it.
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
      );
    }
    const file = resolveStaticPath('/', this.staticDir);
    if (file && sendStaticFile(res, file, { headOnly: method === 'HEAD' })) return;
    sendPlaceholderPage(res);
  }

  /**
   * `POST /pair` — the only way a Phone gets a Token.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handlePair(req, res) {
    const body = await readJsonBody(req, 16 * 1024);
    if (body === null || typeof body !== 'object') {
      throw new HttpError(400, 'invalid_body', '请求体必须是一个对象');
    }
    const payload = /** @type {Record<string, unknown>} */ (body);
    if (typeof payload.code !== 'string' || payload.code.trim() === '') {
      throw new HttpError(400, 'missing_code', '缺少配对码');
    }
    const result = this.pairing.attemptPair(payload.code, {
      deviceName: payload.deviceName,
      deviceModel: payload.deviceModel,
    });
    if (!result.ok) {
      sendError(res, 401, result.error, result.message);
      return;
    }
    // A fresh Token invalidates every previously issued credential, including
    // the cookie the settings page may be holding.
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${result.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    this.logger.info(`pairing completed with ${result.device.deviceName}`);
    this.emit('paired', result.device);
    sendJson(res, 200, { token: result.token });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   */
  _handleState(res) {
    const config = this.configStore.snapshot();
    const link = this.getLink();
    sendJson(res, 200, {
      config,
      connection: link ? link.describe() : { connected: false, deviceName: null, since: null },
      helper: this.helper.describe(),
      paired: this.pairing.isPaired(),
      paused: this.isPaused(),
      version: this.version,
      lanAddress: this.lanAddress(),
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handlePatchConfig(req, res) {
    const body = await readJsonBody(req, 64 * 1024);
    const result = this.configStore.patch(body);
    if (!result.ok) {
      sendError(res, 400, result.error, result.message);
      return;
    }
    this.emit('config', result.config);
    sendJson(res, 200, result.config);
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  _handleHistoryList(res, url) {
    const limitRaw = url.searchParams.get('limit');
    /** @type {number|undefined} */
    let limit;
    if (limitRaw !== null && limitRaw !== '') {
      const parsed = Number.parseInt(limitRaw, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new HttpError(400, 'invalid_limit', 'limit 必须是非负整数');
      }
      limit = parsed;
    }
    let items;
    try {
      items = this.history.list({
        from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined,
        limit,
      });
    } catch (err) {
      throw new HttpError(400, 'invalid_range', `时间范围不合法：${/** @type {Error} */ (err).message}`);
    }
    sendJson(res, 200, { items });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} id
   */
  async _handleHistoryRaw(res, id) {
    const item = this.history.get(id);
    if (!item) throw new HttpError(404, 'not_found', '历史条目不存在');
    const absolute = this.history.resolveFile(item);
    if (!absolute) {
      this.logger.error(`history item ${id} points outside the history root; refusing to serve it`);
      throw new HttpError(500, 'bad_storage_path', '历史条目路径非法');
    }
    const fs = require('node:fs');
    let stat;
    try {
      stat = await fs.promises.stat(absolute);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        throw new HttpError(404, 'file_missing', '历史文件已不存在');
      }
      throw err;
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
      'Content-Disposition': `inline; filename="${encodeURIComponent(`${item.id}.png`)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(absolute);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {string} id
   */
  async _handleHistoryDelete(res, id) {
    const removed = await this.history.remove(id);
    if (!removed) throw new HttpError(404, 'not_found', '历史条目不存在');
    this.emit('history-changed');
    sendJson(res, 200, { ok: true });
  }

  /**
   * `POST /api/history/:id/copy` — put a Capture back on the PC clipboard.
   * @param {import('node:http').ServerResponse} res
   * @param {string} id
   */
  _handleHistoryCopy(res, id) {
    const item = this.history.get(id);
    if (!item) throw new HttpError(404, 'not_found', '历史条目不存在');
    const absolute = this.history.resolveFile(item);
    if (!absolute) throw new HttpError(500, 'bad_storage_path', '历史条目路径非法');
    if (!this.helper.isRunning) {
      throw new HttpError(503, 'helper_unavailable', '原生助手不可用，无法写入剪贴板');
    }
    if (!this.helper.setClipboardImage(absolute)) {
      throw new HttpError(503, 'helper_unavailable', '无法把图片交给原生助手');
    }
    sendJson(res, 200, { ok: true });
  }

  /**
   * `GET /api/clipboard` — 最近的剪贴板同步活动。
   *
   * 存在的理由：剪贴板同步原本完全透明，用户看不到"刚同步了什么"，
   * 排查时无法区分「没同步」「同步了但内容不对」和「被 Echo 抑制吃掉了」。
   * 只返回预览，不返回全文（剪贴板里可能是密码）。
   *
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  _handleClipboardLog(res, url) {
    const log = this.clipboardLog;
    if (!log) {
      sendJson(res, 200, { items: [], note: 'clipboard log disabled' });
      return;
    }
    const limitRaw = url.searchParams.get('limit');
    const parsed = limitRaw === null ? NaN : Number.parseInt(limitRaw, 10);
    sendJson(res, 200, { items: log.list(Number.isFinite(parsed) ? parsed : undefined) });
  }

  /**
   * `POST /api/pairing-code` — mint a code and the QR payload.
   * @param {import('node:http').ServerResponse} res
   */
  async _handlePairingCode(res) {
    const { code, expiresAt } = this.pairing.mintCode();
    const port = this.configStore.get().port;
    const host = this.lanAddress();
    const qrPayload = this.pairing.qrPayload(host, port, code);
    let qrSvg = null;
    if (this.qrcode) {
      try {
        qrSvg = await this.qrcode.toString(qrPayload, { type: 'svg', margin: 1, width: 240 });
      } catch (err) {
        // The QR is a convenience; the payload and the code still work.
        this.logger.warn('QR rendering failed', { error: /** @type {Error} */ (err).message });
      }
    }
    // Hand the Tray a QR window if the helper is up.
    if (this.helper.isRunning) this.helper.showQr(qrPayload);
    this.emit('pairing-code', { code, expiresAt, qrPayload });
    sendJson(res, 200, { code, expiresAt, qrPayload, qrSvg });
  }

  /**
   * @param {import('node:http').ServerResponse} res
   */
  _handleRevoke(res) {
    const result = this.pairing.revoke();
    if (result.revoked) {
      const link = this.getLink();
      if (link) link.close('token-revoked');
      this.emit('revoked');
    }
    // Clear the page's session cookie so it does not keep presenting a dead token.
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    sendJson(res, 200, { ok: true });
  }

  /**
   * `POST /api/sync` — pause/resume Capture and Clipboard Sync.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handleSync(req, res) {
    const body = await readJsonBody(req, 4096);
    if (body === null || typeof body !== 'object' || typeof /** @type {any} */ (body).paused !== 'boolean') {
      throw new HttpError(400, 'invalid_body', '请求体必须是 {"paused": true|false}');
    }
    const paused = /** @type {boolean} */ (/** @type {any} */ (body).paused);
    if (this.setPaused) await this.setPaused(paused);
    this.emit('paused', paused);
    sendJson(res, 200, { paused });
  }

  /**
   * `POST /api/reveal` — open Explorer at History or the storage root.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async _handleReveal(req, res) {
    const body = await readJsonBody(req, 4096);
    const payload = /** @type {Record<string, unknown>} */ (body || {});
    const target = payload.target;
    if (target !== 'history' && target !== 'storage') {
      throw new HttpError(400, 'invalid_target', 'target 只能是 history 或 storage');
    }
    if (!this.revealInExplorer) {
      throw new HttpError(503, 'unsupported', '当前环境不支持打开文件管理器');
    }
    /** @type {string} */
    let absolute;
    if (target === 'storage') {
      absolute = this.history.dir;
    } else if (typeof payload.id === 'string' && payload.id !== '') {
      const item = this.history.get(payload.id);
      if (!item) throw new HttpError(404, 'not_found', '历史条目不存在');
      const file = this.history.resolveFile(item);
      if (!file) throw new HttpError(500, 'bad_storage_path', '历史条目路径非法');
      absolute = file;
    } else {
      absolute = this.history.dir;
    }
    this.revealInExplorer(absolute);
    sendJson(res, 200, { ok: true });
  }

  /**
   * WebSocket upgrade on `/ws` (PROTOCOL §5).
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  _onUpgrade(req, socket, head) {
    socket.on('error', (err) => {
      this.logger.debug(`upgrade socket error: ${err.message}`);
    });
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.headers.upgrade === undefined || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    // The handshake must fail with 401 BEFORE Sec-WebSocket-Accept is sent
    // (PROTOCOL §5), otherwise the client thinks it is connected.
    if (!this.isAuthorized(req)) {
      this.logger.warn(`rejected WebSocket handshake from ${req.socket.remoteAddress || 'unknown'}`);
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    let connection;
    try {
      connection = this.wsServer.accept(req, socket, head);
    } catch (err) {
      this.logger.warn('websocket handshake failed', { error: /** @type {Error} */ (err).message });
      socket.destroy();
      return;
    }
    this.emit('connection', connection);
  }
}

module.exports = {
  HttpServer,
  HttpError,
  PUBLIC_ROUTES,
  COOKIE_NAME,
  parseCookies,
  readJsonBody,
  sendJson,
  sendError,
  MAX_BODY_BYTES,
};

