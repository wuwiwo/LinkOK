/* LinkOK — 概览 (overview)
 *
 * This is the page's one and only elevated surface: the connection card. The two
 * facts below it are flat ListItem rows with outline-variant rules, and the
 * action row sits under those. Nothing here may become a second card — that is
 * the specific anti-pattern SPEC §6.3 names ("三个并列圆角卡").
 *
 * The status is always dot + text; the dot is `primary` when the Link is up and
 * `outline` otherwise, and colour is never the only carrier of the state.
 */
(function (root) {
  'use strict';

  var views = (root.LinkOK = root.LinkOK || {}).views || (root.LinkOK.views = {});

  function esc(value) {
    return root.LinkOK.util.escapeHtml(value);
  }

  function formatDuration(fromIso, now) {
    var util = root.LinkOK.util;
    var from = util.parseInstant(fromIso);
    if (!from) return '';
    var totalMinutes = Math.max(0, Math.floor((now - from.getTime()) / 60000));
    if (totalMinutes < 1) return '刚刚连上';
    if (totalMinutes < 60) return '已连接 ' + totalMinutes + ' 分钟';
    var hours = Math.floor(totalMinutes / 60);
    var minutes = totalMinutes % 60;
    if (hours < 24) return '已连接 ' + hours + ' 小时' + (minutes ? ' ' + minutes + ' 分钟' : '');
    var days = Math.floor(hours / 24);
    return '已连接 ' + days + ' 天' + (hours % 24 ? ' ' + (hours % 24) + ' 小时' : '');
  }

  /**
   * Work out the address to show for this PC. The Hub is authoritative; when it
   * does not say, fall back to the page's own origin, which is correct whenever
   * the page was reached over the LAN and merely unhelpful over loopback.
   */
  function describeOrigin(state) {
    var util = root.LinkOK.util;
    var host = state && state.host ? state.host : root.location ? root.location.hostname : '';
    var port =
      state && state.config && state.config.port
        ? state.config.port
        : root.location && root.location.port
          ? root.location.port
          : '8787';
    var loopback = util.isLoopbackHost(host);
    return {
      text: (host || '本机') + ':' + port,
      loopback: loopback,
      host: host,
      port: port
    };
  }

  function statusModel(state) {
    var paused = Boolean(state && state.paused);
    var connected = Boolean(state && state.connection && state.connection.connected);
    if (paused) return { key: 'paused', on: false, text: '已暂停', detail: '不会收发截图和剪贴板' };
    if (connected) return { key: 'on', on: true, text: '已连接', detail: '' };
    return { key: 'off', on: false, text: '未连接', detail: '手机不在线，或还没配对' };
  }

  function renderCard(state, now) {
    var status = statusModel(state);
    var origin = describeOrigin(state);
    var deviceName = (state.connection && state.connection.deviceName) || '手机';
    var since = state.connection && state.connection.since;
    var connected = status.key === 'on';

    var detail = status.detail;
    if (connected && since) {
      var duration = formatDuration(since, now);
      if (duration) detail = duration;
    }

    return (
      '<section class="status-card" aria-labelledby="overview-card-title">' +
      '<h2 class="visually-hidden" id="overview-card-title">连接状态</h2>' +
      '<div class="bridge">' +
      '<div class="bridge__end">' +
      '<span class="bridge__glyph bridge__glyph--active" data-icon="pc" aria-hidden="true"></span>' +
      '<span class="bridge__name">这台电脑</span>' +
      '<span class="bridge__meta tnum">' + esc(origin.text) + '</span>' +
      '</div>' +
      '<div class="bridge__link" aria-hidden="true">' +
      '<span class="bridge__line' + (connected ? ' bridge__line--up' : '') + '"></span>' +
      '</div>' +
      '<div class="bridge__end">' +
      '<span class="bridge__glyph' + (connected ? ' bridge__glyph--active' : '') + '" data-icon="phone" aria-hidden="true"></span>' +
      '<span class="bridge__name">' + esc(deviceName) + '</span>' +
      '<span class="bridge__meta">' + (connected ? '手机在线' : '等待手机') + '</span>' +
      '</div>' +
      '</div>' +
      '<p class="status-line">' +
      '<span class="status-dot' + (status.on ? ' status-dot--on' : '') + '" aria-hidden="true"></span>' +
      '<span class="status-line__text">' + esc(status.text) + '</span>' +
      (detail ? '<span class="status-line__detail">' + esc(detail) + '</span>' : '') +
      '</p>' +
      (origin.loopback
        ? '<p class="list-item__sub">你正通过本机地址打开设置页。手机要用电脑的局域网地址才能连上。</p>'
        : '') +
      '</section>'
    );
  }

  function renderRows(state, stats, now) {
    var util = root.LinkOK.util;
    var sessionCount = stats.sessionCount;
    var latest = stats.latest;

    var sessionRow =
      '<li class="list-item">' +
      '<span class="list-item__leading" data-icon="clock" aria-hidden="true"></span>' +
      '<div class="list-item__body">' +
      '<p class="list-item__title">本次会话</p>' +
      '<p class="list-item__sub">' +
      (stats.sessionSinceLabel ? '从 ' + esc(stats.sessionSinceLabel) + ' 开始' : 'Hub 启动以来的截图') +
      '</p>' +
      '</div>' +
      '<span class="list-item__trailing tnum">' + esc(sessionCount) + ' 张</span>' +
      '</li>';

    var latestRow;
    if (latest) {
      var thumb = latest.thumb || root.LinkOK.api.rawUrl(latest.id);
      latestRow =
        '<li>' +
        '<a class="list-item list-item--interactive" href="#/history">' +
        '<span class="list-item__leading" data-icon="image" aria-hidden="true"></span>' +
        '<div class="list-item__body">' +
        '<p class="list-item__title">最近一张</p>' +
        '<p class="list-item__sub">' + esc(util.sourceLabel(latest.source)) + '</p>' +
        '</div>' +
        '<span class="list-item__trailing">' +
        '<span class="tnum">' + esc(util.formatTime(latest.arrivedAt)) + '</span>' +
        '<img class="thumb" src="' + esc(thumb) + '" alt="" width="56" height="56" loading="lazy" />' +
        '</span>' +
        '</a>' +
        '</li>';
    } else {
      latestRow =
        '<li>' +
        '<a class="list-item list-item--interactive" href="#/history">' +
        '<span class="list-item__leading" data-icon="image" aria-hidden="true"></span>' +
        '<div class="list-item__body">' +
        '<p class="list-item__title">最近一张</p>' +
        '<p class="list-item__sub">还没有截图。在手机或电脑上截一张，它会出现在这里。</p>' +
        '</div>' +
        '<span class="list-item__trailing">去看看</span>' +
        '</a>' +
        '</li>';
    }

    return '<ul class="list">' + sessionRow + latestRow + '</ul>';
  }

  function renderActions(state) {
    var paused = Boolean(state && state.paused);
    return (
      '<div class="actions-row">' +
      '<button class="btn btn--filled" type="button" data-action="pair">' +
      root.LinkOK.icons.svg('plus', { size: 18 }) + '配对新设备' +
      '</button>' +
      '<button class="btn btn--outlined" type="button" data-action="toggle-pause">' +
      root.LinkOK.icons.svg(paused ? 'play' : 'pause', { size: 18 }) +
      (paused ? '恢复同步' : '暂停同步') +
      '</button>' +
      '</div>'
    );
  }

  function errorBanner(result) {
    return (
      '<div class="banner banner--error" role="alert">' +
      '<span class="list-item__leading" data-icon="alert" aria-hidden="true"></span>' +
      '<div class="banner__body">' +
      '<p class="banner__title">读不到 Hub 的状态</p>' +
      '<p class="banner__text">' + esc(result.message) + '</p>' +
      '<div class="banner__actions">' +
      '<button class="btn btn--outlined" type="button" data-action="retry">重试</button>' +
      '<button class="btn btn--text" type="button" data-action="demo">用演示数据看看</button>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function demoBanner() {
    return (
      '<div class="banner banner--info">' +
      '<span class="list-item__leading" data-icon="info" aria-hidden="true"></span>' +
      '<div class="banner__body">' +
      '<p class="banner__title">演示数据</p>' +
      '<p class="banner__text">这是内置的示例内容，没有连接 Hub。去掉地址里的 <code>?demo=1</code> 即可读真实数据。</p>' +
      '</div>' +
      '</div>'
    );
  }

  views.overview = {
    title: '概览',
    mount: function (container, ctx) {
      var util = root.LinkOK.util;
      var ui = root.LinkOK.ui;
      var state = ctx.getState();
      var error = ctx.getError();

      if (!state) {
        ui.renderInto(
          container,
          '<header class="page-head"><h1 class="page-head__title">概览</h1></header>' +
            (error ? errorBanner(error) : '<p class="loading">正在读取状态…</p>')
        );
        ui.delegate(container, 'click', {
          retry: function () {
            ctx.reload();
          },
          demo: function () {
            ctx.enterDemo();
          }
        });
        return;
      }

      var now = new Date();
      var stats = ctx.getStats(now);
      var html =
        '<header class="page-head">' +
        '<h1 class="page-head__title">概览</h1>' +
        '<p class="page-head__meta">' +
        (ctx.isDemo() ? '演示数据' : 'Hub v' + esc(state.version || '0.1.0')) +
        '</p>' +
        '</header>' +
        (ctx.isDemo() ? demoBanner() : '') +
        renderCard(state, now) +
        renderRows(state, stats, now) +
        renderActions(state);

      ui.renderInto(container, html);

      ui.delegate(container, 'click', {
        pair: function () {
          root.LinkOK.pairing.open(ctx);
        },
        'toggle-pause': function (button) {
          var next = !ctx.getState().paused;
          button.disabled = true;
          ctx
            .setPaused(next)
            .then(function (result) {
              button.disabled = false;
              if (!result.ok) {
                ui.showSnackbar(result.message, { duration: 6000 });
                return;
              }
              ui.showSnackbar(next ? '已暂停同步' : '已恢复同步');
              ctx.render();
            });
        }
      });

      // The "最近一张" thumbnail may 404 if Retention removed it mid-session.
      var img = container.querySelector('.thumb');
      if (img) {
        img.addEventListener('error', function () {
          var holder = img.parentNode;
          if (!holder) return;
          var empty = root.document.createElement('span');
          empty.className = 'thumb thumb--empty';
          empty.innerHTML = root.LinkOK.icons.svg('image', { size: 20 });
          holder.replaceChild(empty, img);
        });
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
