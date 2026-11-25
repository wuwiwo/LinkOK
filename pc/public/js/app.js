/* LinkOK — application bootstrap.
 *
 * Responsibilities, in order:
 *   1. decide the transport (live or demo) from ?demo=1
 *   2. own the single copy of application state and the one place it is fetched
 *   3. hash routing between the four sections
 *   4. paint the rail's current destination
 *   5. expose a small context object to views
 *
 * Views are pure-ish: they receive a container and this context, they never
 * fetch directly (except through the context, which re-renders them) and they
 * never write to the DOM outside their own container.
 *
 * Failure policy: a failed /api/state is a first-class UI state, not an
 * exception. With ?demo=1 the network is not touched at all.
 */
(function (root) {
  'use strict';

  var util = root.LinkOK.util;
  var ui = root.LinkOK.ui;
  var api = root.LinkOK.api;

  var ROUTES = [
    { id: 'overview', label: '概览', view: 'overview' },
    { id: 'history', label: '历史', view: 'history' },
    { id: 'devices', label: '设备', view: 'devices' },
    { id: 'settings', label: '设置', view: 'settings' }
  ];

  var DEFAULT_ROUTE = 'overview';

  var app = {
    route: DEFAULT_ROUTE,
    state: null,
    error: null,
    historyItems: null,
    historyLoading: false,
    pairings: null,
    pendingPort: null,
    demo: false,
    now: new Date(),
    ticker: null
  };

  var viewHost = null;

  // ------------------------------------------------------------- routing

  function routeFromHash() {
    var hash = (root.location.hash || '').replace(/^#\/?/, '');
    var id = hash.split('?')[0].split('/')[0];
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].id === id) return ROUTES[i].id;
    return DEFAULT_ROUTE;
  }

  function paintRail(routeId) {
    var links = root.document.querySelectorAll('.rail__link');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (link.getAttribute('data-nav') === routeId) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  function setDocumentTitle(routeId) {
    var route = findRoute(routeId);
    root.document.title = route && routeId !== DEFAULT_ROUTE ? 'LinkOK — ' + route.label : 'LinkOK';
  }

  function findRoute(id) {
    for (var i = 0; i < ROUTES.length; i++) if (ROUTES[i].id === id) return ROUTES[i];
    return null;
  }

  // ------------------------------------------------------------- loading

  function loadState() {
    app.error = null;
    return api.getState().then(function (result) {
      if (!result.ok) {
        app.state = null;
        app.error = result;
        // A network/credential failure with no explicit demo request still gets
        // an offer to look at demo data — but we do not switch silently, because
        // showing fake numbers as if they were real would be a lie.
        return result;
      }
      app.state = result.data || null;
      return result;
    });
  }

  function loadHistory() {
    if (app.historyLoading) return Promise.resolve();
    app.historyLoading = true;
    app.historyItems = app.historyItems === null ? null : app.historyItems;
    return api
      .getHistory({ limit: 200 })
      .then(function (result) {
        app.historyLoading = false;
        if (result.ok && result.data && Array.isArray(result.data.items)) {
          app.historyItems = result.data.items;
        } else if (!result.ok) {
          app.historyError = result;
          if (app.historyItems === null) app.historyItems = null;
        }
        return result;
      });
  }

  function loadPairings() {
    return api.getPairings().then(function (result) {
      if (result.ok) app.pairings = result.data;
      return result;
    });
  }

  function reload() {
    render();
    var jobs = [loadState()];
    if (app.route === 'history') jobs.push(loadHistory());
    if (app.route === 'devices') jobs.push(loadPairings());
    return Promise.all(jobs).then(function () {
      app.now = new Date();
      refreshRailMeta();
      render();
    });
  }

  // ------------------------------------------------------------- context

  function getStats(now) {
    var items = app.historyItems || [];
    var since = app.state && app.state.connection ? app.state.connection.since : null;
    var sinceDate = util.parseInstant(since);
    var sessionItems = sinceDate
      ? items.filter(function (item) {
          var at = util.parseInstant(item.arrivedAt);
          return at && at.getTime() >= sinceDate.getTime();
        })
      : items;

    var sessionCount =
      app.state && typeof app.state.sessionCount === 'number' ? app.state.sessionCount : sessionItems.length;

    return {
      sessionCount: sessionCount,
      sessionSinceLabel: sinceDate ? util.formatTime(since) : '',
      latest: items.length ? items[0] : null
    };
  }

  var ctx = {
    isDemo: function () {
      return app.demo;
    },
    getState: function () {
      return app.state;
    },
    getError: function () {
      return app.error;
    },
    getHistoryItems: function () {
      return app.historyItems;
    },
    isHistoryLoading: function () {
      return app.historyLoading;
    },
    findHistoryItem: function (id) {
      var items = app.historyItems || [];
      for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
      return null;
    },
    getPairings: function () {
      return app.pairings;
    },
    getStats: getStats,
    getPendingPort: function () {
      return app.pendingPort;
    },
    setPendingPort: function (value) {
      app.pendingPort = value;
    },
    applyConfig: function (config) {
      if (app.state && config) app.state.config = config;
    },
    render: render,
    reload: reload,
    setPaused: function (paused) {
      return api.setPaused(paused).then(function (result) {
        if (result.ok && app.state) {
          app.state.paused = typeof result.data.paused === 'boolean' ? result.data.paused : paused;
        }
        return result;
      });
    },
    enterDemo: function () {
      var next = root.location.pathname + '?demo=1' + (root.location.hash || '');
      root.history.replaceState(null, '', next);
      app.demo = true;
      api.setMode('demo');
      app.historyItems = null;
      app.pairings = null;
      reload();
    }
  };

  // -------------------------------------------------------------- render

  function render() {
    if (!viewHost) return;
    var route = findRoute(app.route) || ROUTES[0];
    var view = root.LinkOK.views[route.view];
    paintRail(app.route);
    setDocumentTitle(app.route);
    if (!view || typeof view.mount !== 'function') {
      viewHost.innerHTML = '<p class="loading">这个分区还没做好。</p>';
      return;
    }
    try {
      view.mount(viewHost, ctx);
    } catch (err) {
      if (root.console) console.error('[linkok] view crashed:', err);
      viewHost.innerHTML =
        '<div class="banner banner--error" role="alert">' +
        '<span class="list-item__leading" data-icon="alert" aria-hidden="true"></span>' +
        '<div class="banner__body">' +
        '<p class="banner__title">这个页面出错了</p>' +
        '<p class="banner__text">' + util.escapeHtml(err && err.message ? err.message : String(err)) + '</p>' +
        '<div class="banner__actions">' +
        '<button class="btn btn--outlined" type="button" data-action="retry">重试</button>' +
        '</div></div></div>';
      ui.hydrateIcons(viewHost);
      ui.delegate(viewHost, 'click', { retry: function () { reload(); } });
    }
  }

  function refreshRailMeta() {
    var node = root.document.getElementById('rail-meta');
    if (!node) return;
    if (app.demo) {
      node.textContent = '演示数据';
      return;
    }
    if (!app.state) {
      node.textContent = 'Hub 未连接';
      return;
    }
    var connected = app.state.connection && app.state.connection.connected;
    var paused = app.state.paused;
    node.textContent = paused ? '已暂停' : connected ? '已连接' : '未连接';
  }

  // --------------------------------------------------------------- boot

  function onRouteChange() {
    var next = routeFromHash();
    if (next !== app.route) {
      app.route = next;
      app.pendingPort = null;
    }
    render();
    // Fetch what this section needs, then repaint once it arrives.
    var jobs = [];
    if (app.state === null) jobs.push(loadState());
    if (app.route === 'history') jobs.push(loadHistory());
    if (app.route === 'devices' && app.pairings === null) jobs.push(loadPairings());
    if (jobs.length) {
      Promise.all(jobs).then(function () {
        app.now = new Date();
        refreshRailMeta();
        render();
      });
    }
  }

  function start() {
    viewHost = root.document.getElementById('view');
    app.demo = api.init() === 'demo';

    // Decide the initial route from the hash, defaulting to overview.
    app.route = routeFromHash();

    refreshRailMeta();
    ui.hydrateIcons(root.document);

    root.addEventListener('hashchange', onRouteChange);

    // Keep "已连接 3 分钟" honest without re-fetching anything.
    if (app.ticker) root.clearInterval(app.ticker);
    app.ticker = root.setInterval(function () {
      if (app.route === 'overview' && app.state) {
        app.now = new Date();
        render();
      }
    }, 30000);

    reload();
  }

  if (root.document) {
    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  root.LinkOK.app = {
    ctx: ctx,
    state: app,
    routes: ROUTES,
    start: start,
    reload: reload,
    render: render
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
