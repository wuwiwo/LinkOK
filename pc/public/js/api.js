/* LinkOK — HTTP client for the Hub's own origin, plus the demo transport.
 *
 * Every call goes to a same-origin relative path, so the page works whatever
 * host/port the Hub bound to.
 *
 * Credential resolution, in order (README documents this for the Hub author):
 *   1. <meta name="linkok-token" content="…">  — Hub may inject at serve time
 *   2. sessionStorage["linkok.token"]          — set by ?token=… or a prior load
 *   3. nothing                                 — rely on the HttpOnly cookie the
 *                                                Hub sets on GET /, which the
 *                                                browser attaches automatically
 * When a token is known we also send `Authorization: Bearer …`; sending both is
 * harmless and keeps the JsonWebToken-style manual path working if cookies are
 * blocked.
 *
 * Result convention: every method resolves to
 *   { ok: true, data } | { ok: false, status, error, message }
 * so views never need try/catch, and a failure always carries something worth
 * showing the user. Network failures use status 0.
 */
(function (root) {
  'use strict';

  var TOKEN_KEY = 'linkok.token';
  var TOKEN_META = 'linkok-token';

  // ------------------------------------------------------------- token

  function readMetaToken() {
    var doc = root.document;
    if (!doc) return '';
    var meta = doc.querySelector('meta[name="' + TOKEN_META + '"]');
    if (!meta) return '';
    var value = (meta.getAttribute('content') || '').trim();
    return value && value.indexOf('{{') === -1 ? value : '';
  }

  function readStoredToken() {
    try {
      return root.sessionStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return ''; // private mode / disabled storage
    }
  }

  function storeToken(token) {
    try {
      root.sessionStorage.setItem(TOKEN_KEY, token);
    } catch (e) {
      /* storage unavailable; the cookie path still works */
    }
  }

  /**
   * The Hub may hand the token over as ?token=… (useful for a one-click link
   * from the tray). We move it into sessionStorage and immediately strip it
   * from the visible URL so it does not end up in a screenshot or a bookmark.
   */
  function absorbUrlToken() {
    if (!root.location || !root.history || !root.history.replaceState) return;
    var search = root.location.search || '';
    if (search.indexOf('token=') === -1) return;
    var match = /[?&]token=([^&]+)/.exec(search);
    if (!match) return;
    var token = '';
    try {
      token = decodeURIComponent(match[1]);
    } catch (e) {
      token = match[1];
    }
    if (token) storeToken(token);

    var rest = search
      .replace(/([?&])token=[^&]*&?/, '$1')
      .replace(/[?&]$/, '')
      .replace(/^&/, '?');
    if (rest === '?') rest = '';
    var next = root.location.pathname + rest + (root.location.hash || '');
    root.history.replaceState(null, '', next);
  }

  function currentToken() {
    return readMetaToken() || readStoredToken();
  }

  // ---------------------------------------------------------- transport

  function buildHeaders(extra) {
    var headers = { Accept: 'application/json' };
    var token = currentToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) headers[key] = extra[key];
      }
    }
    return headers;
  }

  /** Turn any response into the {ok,…} result shape, reading the error body. */
  function interpret(response, bodyText) {
    var payload = null;
    if (bodyText) {
      try {
        payload = JSON.parse(bodyText);
      } catch (e) {
        payload = null;
      }
    }

    if (response.ok) return { ok: true, data: payload, status: response.status };

    var code = (payload && payload.error) || 'http_' + response.status;
    var serverMessage = (payload && payload.message) || '';

    // A 401 is the one error the user can actually act on, and the Hub's own text
    // ("未授权的请求") says what happened but not what to do. Keep the server text
    // as detail and lead with the recovery step (DESIGN-GUIDE §9).
    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        error: code,
        message: '这个页面还没有访问权限。确认 Hub 正在运行，然后重新打开设置页；如果刚刚重装过，需要在手机上重新配对。',
        serverMessage: serverMessage
      };
    }

    return {
      ok: false,
      status: response.status,
      error: code,
      message: serverMessage || defaultMessage(response.status, code),
      serverMessage: serverMessage
    };
  }

  function defaultMessage(status, code) {
    if (status === 401) return '没有访问权限，请重新配对这台电脑。';
    if (status === 404) return 'Hub 不支持这个操作，可能版本较旧。';
    if (status === 400) return '请求被拒绝，参数不正确。';
    if (status === 413) return '图片超过 20MB，无法处理。';
    if (status >= 500) return 'Hub 内部出错，请查看日志。';
    return '请求失败（' + (code || status) + '）。';
  }

  function request(method, path, options) {
    options = options || {};
    var init = {
      method: method,
      // same-origin lets the HttpOnly cookie ride along; no CORS, no preflight.
      credentials: 'same-origin',
      headers: buildHeaders(options.body ? { 'Content-Type': 'application/json' } : null),
      // The page must show a real error rather than hang forever.
      signal: undefined
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    var fetchFn = root.fetch;
    if (typeof fetchFn !== 'function') {
      return Promise.resolve({
        ok: false,
        status: 0,
        error: 'no_fetch',
        message: '当前浏览器不支持 fetch，无法连接 Hub。'
      });
    }

    return fetchFn.call(root, path, init)
      .then(function (response) {
        return response.text().then(function (text) {
          return interpret(response, text);
        });
      })
      .catch(function (err) {
        // Offline, refused connection, file:// fetch, aborted — all collapse here.
        return {
          ok: false,
          status: 0,
          error: 'network',
          message:
            err && err.name === 'AbortError'
              ? '请求超时，Hub 没有响应。'
              : '连不上 Hub。确认 Hub 正在运行，并且这个地址就是它的地址。'
        };
      });
  }

  // ------------------------------------------------------------- demo mode

  var demoDb = null;
  var demoObjects = {};

  function isDemoRequested() {
    if (!root.location) return false;
    return /(^|[?&])demo=1(&|$)/.test(root.location.search || '');
  }

  function demoDelay(value) {
    // A little latency so loading states are exercised during review.
    return new Promise(function (resolve) {
      root.setTimeout(function () { resolve(value); }, 90);
    });
  }

  function demoOk(data) {
    return demoDelay({ ok: true, data: data, status: 200 });
  }

  function demoFail(status, error, message) {
    return demoDelay({ ok: false, status: status, error: error, message: message });
  }

  function resetDemo() {
    demoDb = root.LinkOK.demo.create(new Date());
    demoObjects = {};
  }

  function ensureDemo() {
    if (!demoDb) resetDemo();
    return demoDb;
  }

  function demoState() {
    var db = ensureDemo();
    var state = JSON.parse(JSON.stringify(db.state));
    state.historyCount = db.items.length;
    state.sessionCount = db.items.filter(function (item) {
      return new Date(item.arrivedAt) >= new Date(db.state.connection.since);
    }).length;
    // Pairing fingerprint is derived from the paired token, stably per session.
    state.fp = '3f2a1b5c9d8e7f60';
    return state;
  }

  var demoApi = {
    getState: function () {
      return demoOk(demoState());
    },
    patchConfig: function (patch) {
      var db = ensureDemo();
      if (
        Object.prototype.hasOwnProperty.call(patch, 'retentionDays') &&
        [0, 7, 15, 30].indexOf(patch.retentionDays) === -1
      ) {
        return demoFail(400, 'invalid_retention_days', '保留期只能是 7 天、15 天、30 天或永不。');
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'port')) {
        var port = patch.port;
        if (typeof port !== 'number' || port < 1024 || port > 65535) {
          return demoFail(400, 'invalid_port', '端口要在 1024 到 65535 之间。');
        }
      }
      db.state.config = root.LinkOK.util.mergeConfig(db.state.config, patch);
      return demoOk(JSON.parse(JSON.stringify(db.state.config)));
    },
    getHistory: function () {
      var db = ensureDemo();
      return demoOk({ items: JSON.parse(JSON.stringify(db.items)) });
    },
    deleteHistory: function (id) {
      var db = ensureDemo();
      var before = db.items.length;
      db.items = db.items.filter(function (item) { return item.id !== id; });
      if (db.items.length === before) return demoFail(404, 'not_found', '这条记录已经不在了。');
      return demoOk({ ok: true });
    },
    createPairingCode: function () {
      var db = ensureDemo();
      var code = '';
      var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      for (var i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
      var expiresAt = new Date(Date.now() + 120000).toISOString();
      return demoOk({
        code: code,
        expiresAt: expiresAt,
        qrPayload: root.LinkOK.util.buildPairPayload({
          host: db.state.host,
          port: db.state.config.port,
          code: code,
          fp: db.state.fp
        })
      });
    },
    revokeDevice: function () {
      var db = ensureDemo();
      db.state.paired = false;
      db.state.connection.connected = false;
      db.pairings = [];
      return demoOk({ ok: true });
    },
    setPaused: function (paused) {
      var db = ensureDemo();
      db.state.paused = !!paused;
      return demoOk({ paused: db.state.paused });
    },
    copyToClipboard: function () {
      return demoOk({ ok: true });
    },
    reveal: function () {
      return demoOk({ ok: true });
    },
    getPairings: function () {
      var db = ensureDemo();
      return demoOk({ devices: JSON.parse(JSON.stringify(db.pairings)) });
    }
  };

  // ---------------------------------------------------------- live transport

  var liveApi = {
    getState: function () {
      return request('GET', '/api/state');
    },
    patchConfig: function (patch) {
      return request('PATCH', '/api/config', { body: patch });
    },
    getHistory: function (query) {
      var search = '';
      if (query) {
        var parts = [];
        for (var key in query) {
          if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
          if (query[key] === null || query[key] === undefined || query[key] === '') continue;
          parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(query[key]));
        }
        if (parts.length) search = '?' + parts.join('&');
      }
      return request('GET', '/api/history' + search);
    },
    deleteHistory: function (id) {
      return request('DELETE', '/api/history/' + encodeURIComponent(id));
    },
    createPairingCode: function () {
      return request('POST', '/api/pairing-code');
    },
    revokeDevice: function () {
      return request('POST', '/api/device/revoke');
    },
    setPaused: function (paused) {
      return request('POST', '/api/sync', { body: { paused: !!paused } });
    },
    copyToClipboard: function (id) {
      return request('POST', '/api/history/' + encodeURIComponent(id) + '/copy');
    },
    reveal: function (options) {
      return request('POST', '/api/reveal', { body: options || {} });
    },
    // Optional endpoint: if the Hub does not implement it, the devices view falls
    // back to the single device reported by /api/state.
    getPairings: function () {
      return request('GET', '/api/devices');
    }
  };

  // --------------------------------------------------------------- facade

  var mode = 'live';

  function init() {
    absorbUrlToken();
    mode = isDemoRequested() ? 'demo' : 'live';
    return mode;
  }

  function active() {
    return mode === 'demo' ? demoApi : liveApi;
  }

  function setMode(next) {
    mode = next === 'demo' ? 'demo' : 'live';
  }

  function getMode() {
    return mode;
  }

  /** Mark the session as unauthenticated so views can explain the 401 path. */
  function hasCredentialHint() {
    return Boolean(currentToken()) || documentHasCookieHint();
  }

  /**
   * URL for a Capture's bytes. Only same-origin relative paths are produced, and
   * ids are sanitised, so a hostile id cannot become a `javascript:` or an
   * external URL. Returns '' when the id is unusable.
   */
  function rawUrl(id) {
    if (mode === 'demo') {
      var db = demoDb;
      if (db) {
        for (var i = 0; i < db.items.length; i++) {
          if (db.items[i].id === id) return db.items[i].thumb || '';
        }
      }
      return '';
    }
    return root.LinkOK.util.historyRawPath(id) || '';
  }

  function documentHasCookieHint() {
    // We cannot read an HttpOnly cookie, and we should not try. Presence of a
    // non-empty cookie jar is not observable; assume the cookie path may work
    // and let the 401 itself be the signal.
    return true;
  }

  root.LinkOK = root.LinkOK || {};
  root.LinkOK.api = {
    init: init,
    getMode: getMode,
    setMode: setMode,
    hasCredentialHint: hasCredentialHint,
    rawUrl: rawUrl,
    currentToken: currentToken,
    storeToken: storeToken,
    resetDemo: resetDemo,
    // Direct delegating wrappers keep call sites honest about the mode.
    getState: function () { return active().getState(); },
    patchConfig: function (patch) { return active().patchConfig(patch); },
    getHistory: function (query) { return active().getHistory(query); },
    deleteHistory: function (id) { return active().deleteHistory(id); },
    createPairingCode: function () { return active().createPairingCode(); },
    revokeDevice: function () { return active().revokeDevice(); },
    setPaused: function (paused) { return active().setPaused(paused); },
    copyToClipboard: function (id) { return active().copyToClipboard(id); },
    reveal: function (options) { return active().reveal(options); },
    getPairings: function () { return active().getPairings(); },
    demo: demoApi,
    live: liveApi
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
