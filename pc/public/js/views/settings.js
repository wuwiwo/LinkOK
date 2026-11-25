/* LinkOK — 设置 (settings)
 *
 * Every setting is a ListItem row with a trailing control (SPEC §6.3: "设置项一律
 * ListItem + 尾部控件，不装箱成卡片"). There is no card in this view, and no
 * generic container that could become one.
 *
 * Writes go through one path: collect a patch, PATCH /api/config, and only then
 * repaint. The control is reverted if the Hub rejects the change, so the UI never
 * shows a value the Hub does not have.
 */
(function (root) {
  'use strict';

  var views = (root.LinkOK = root.LinkOK || {}).views || (root.LinkOK.views = {});

  function esc(value) {
    return root.LinkOK.util.escapeHtml(value);
  }

  function switchRow(opts) {
    var checked = Boolean(opts.checked);
    var disabled = Boolean(opts.disabled);
    return (
      '<li class="list-item">' +
      '<div class="list-item__body" id="' + esc(opts.id) + '-label">' +
      '<p class="list-item__title">' + esc(opts.title) + '</p>' +
      (opts.sub ? '<p class="list-item__sub">' + esc(opts.sub) + '</p>' : '') +
      '</div>' +
      '<button class="switch" type="button" role="switch"' +
      ' aria-checked="' + (checked ? 'true' : 'false') + '"' +
      ' aria-labelledby="' + esc(opts.id) + '-label"' +
      ' data-action="toggle" data-key="' + esc(opts.key) + '"' +
      (disabled ? ' disabled' : '') +
      '><span class="switch__handle"></span></button>' +
      '</li>'
    );
  }

  var RETENTION_CHOICES = [
    { value: 7, label: '7 天', hint: '空间紧张时选这个' },
    { value: 15, label: '15 天', hint: '' },
    { value: 30, label: '30 天', hint: '默认' },
    { value: 0, label: '永不', hint: '只受手机 500MB 上限约束' }
  ];

  function retentionRows(current) {
    return RETENTION_CHOICES.map(function (choice) {
      var id = 'retention-' + choice.value;
      return (
        '<label class="radio-row" for="' + id + '">' +
        '<input type="radio" id="' + id + '" name="retentionDays" value="' + choice.value + '"' +
        (Number(current) === choice.value ? ' checked' : '') +
        ' data-action="retention" />' +
        '<span class="radio-row__mark" aria-hidden="true"></span>' +
        '<span class="radio-row__label">' + esc(choice.label) + '</span>' +
        '<span class="radio-row__hint">' + esc(choice.hint) + '</span>' +
        '</label>'
      );
    }).join('');
  }

  function settingsView(container, ctx) {
    var ui = root.LinkOK.ui;
    var util = root.LinkOK.util;
    var state = ctx.getState();
    var error = ctx.getError();

    if (!state) {
      ui.renderInto(
        container,
        '<header class="page-head"><h1 class="page-head__title">设置</h1></header>' +
          '<div class="banner banner--error" role="alert">' +
          '<span class="list-item__leading" data-icon="alert" aria-hidden="true"></span>' +
          '<div class="banner__body">' +
          '<p class="banner__title">读不到设置</p>' +
          '<p class="banner__text">' + esc((error && error.message) || 'Hub 没有响应。') + '</p>' +
          '<div class="banner__actions">' +
          '<button class="btn btn--outlined" type="button" data-action="retry">重试</button>' +
          '<button class="btn btn--text" type="button" data-action="demo">用演示数据看看</button>' +
          '</div></div></div>'
      );
      ui.delegate(container, 'click', {
        retry: function () { ctx.reload(); },
        demo: function () { ctx.enterDemo(); }
      });
      return;
    }

    var config = state.config || {};
    var notifications = config.notifications || {};
    var notifEnabled = notifications.enabled !== false;
    var pendingPort = ctx.getPendingPort();

    ui.renderInto(
      container,
      '<header class="page-head">' +
        '<h1 class="page-head__title">设置</h1>' +
        '<p class="page-head__meta">' + (ctx.isDemo() ? '演示数据' : '改动立即生效') + '</p>' +
        '</header>' +

        '<h2 class="section-title">连接</h2>' +
        '<ul class="list">' +
        '<li class="list-item">' +
        '<div class="list-item__body" id="port-label">' +
        '<p class="list-item__title">端口</p>' +
        '<p class="list-item__sub">手机用这个端口连接。UDP 发现端口固定是 8788。</p>' +
        '</div>' +
        '<div class="field">' +
        '<input type="number" inputmode="numeric" min="1024" max="65535" step="1"' +
        ' value="' + esc(pendingPort == null ? config.port || 8787 : pendingPort) + '"' +
        ' aria-labelledby="port-label" data-field="port" />' +
        '</div>' +
        '<button class="btn btn--text" type="button" data-action="save-port">保存</button>' +
        '</li>' +
        '<li class="list-item">' +
        '<div class="list-item__body">' +
        '<p class="list-item__title">存储路径</p>' +
        '<p class="list-item__sub code-value" data-storage-path>' +
        esc(config.screenshotDir || '由系统决定') +
        '</p>' +
        '<p class="list-item__sub">History 存在 %LOCALAPPDATA%\\LinkOK\\history。</p>' +
        '</div>' +
        '<button class="btn btn--text" type="button" data-action="open-folder"' +
        ' aria-label="在文件资源管理器中打开存储目录">打开目录</button>' +
        '</li>' +
        '</ul>' +

        '<h2 class="section-title">保留期</h2>' +
        '<p class="list-item__sub" style="margin:0 0 var(--sp-2)">' +
        '按截图进入 LinkOK 的时间计算，只清理 LinkOK 自己的副本，不碰手机相册。' +
        '</p>' +
        '<fieldset class="radio-group">' +
        '<legend class="visually-hidden">保留期</legend>' +
        retentionRows(config.retentionDays) +
        '</fieldset>' +

        '<h2 class="section-title">通知</h2>' +
        '<ul class="list">' +
        switchRow({
          id: 'notif-enabled',
          key: 'notifications.enabled',
          title: '显示通知',
          sub: '关掉之后下面三项都不再弹出',
          checked: notifEnabled
        }) +
        switchRow({
          id: 'notif-capture',
          key: 'notifications.captureDelivered',
          title: '截图送达',
          sub: '手机截图到达这台电脑时提示',
          checked: notifications.captureDelivered !== false,
          disabled: !notifEnabled
        }) +
        switchRow({
          id: 'notif-clip',
          key: 'notifications.clipboardSynced',
          title: '剪贴板同步',
          sub: '每次同步都提示，容易刷屏，默认关闭',
          checked: Boolean(notifications.clipboardSynced),
          disabled: !notifEnabled
        }) +
        switchRow({
          id: 'notif-errors',
          key: 'notifications.errors',
          title: '异常和断线',
          sub: '手机离线超过 5 分钟、端口被占用、配对失败',
          checked: notifications.errors !== false,
          disabled: !notifEnabled
        }) +
        '</ul>' +

        '<h2 class="section-title">启动</h2>' +
        '<ul class="list">' +
        switchRow({
          id: 'autostart',
          key: 'autostart',
          title: '开机自动启动',
          sub: '登录 Windows 后在托盘里启动 Hub',
          checked: config.autostart !== false
        }) +
        '</ul>' +

        (ctx.isDemo()
          ? '<div class="banner banner--info" style="margin-top: var(--sp-5)">' +
            '<span class="list-item__leading" data-icon="info" aria-hidden="true"></span>' +
            '<div class="banner__body"><p class="banner__text">' +
            '演示数据。改动只保存在这次页面会话里，刷新就回到默认值。' +
            '</p></div></div>'
          : '') +

        '<h2 class="section-title">关于</h2>' +
        '<ul class="list">' +
        '<li class="list-item">' +
        '<div class="list-item__body">' +
        '<p class="list-item__title">LinkOK</p>' +
        '<p class="list-item__sub tnum">Hub v' + esc(state.version || '0.1.0') +
        ' · 本页通过 ' + esc(root.location ? root.location.host || '本机' : '本机') + ' 打开</p>' +
        '</div>' +
        '</li>' +
        '</ul>'
    );

    // ---- port field: keep the typed value across repaints
    var portField = container.querySelector('[data-field="port"]');
    if (portField) {
      portField.addEventListener('input', function () {
        ctx.setPendingPort(portField.value);
      });
      portField.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          savePort(ctx);
        }
      });
    }

    ui.delegate(container, 'click', {
      retry: function () { ctx.reload(); },
      demo: function () { ctx.enterDemo(); },
      'save-port': function () {
        savePort(ctx);
      },
      'open-folder': function () {
        root.LinkOK.api.reveal({ target: 'storage' }).then(function (result) {
          if (result.ok) return;
          ui.showSnackbar(
            result.status === 404
              ? 'Hub 还不支持打开目录。路径是 ' + ((ctx.getState().config || {}).screenshotDir || '系统截图文件夹')
              : result.message,
            { duration: 7000 }
          );
        });
      }
    });

    // ---- switches: optimistic-looking but reverted on rejection
    var switches = container.querySelectorAll('.switch');
    for (var i = 0; i < switches.length; i++) {
      switches[i].addEventListener('click', function (event) {
        var button = event.currentTarget;
        var key = button.getAttribute('data-key');
        var next = button.getAttribute('aria-checked') !== 'true';
        applyToggle(ctx, button, key, next);
      });
    }

    // ---- retention radios
    var radios = container.querySelectorAll('input[name="retentionDays"]');
    for (var r = 0; r < radios.length; r++) {
      radios[r].addEventListener('change', function (event) {
        var value = Number(event.currentTarget.value);
        applyRetention(ctx, value, event.currentTarget);
      });
    }
  }

  function savePort(ctx) {
    var ui = root.LinkOK.ui;
    var raw = ctx.getPendingPort();
    var port = Number(raw);
    if (!raw || !isFinite(port) || Math.floor(port) !== port || port < 1024 || port > 65535) {
      ui.showSnackbar('端口要在 1024 到 65535 之间', { duration: 5000 });
      return;
    }
    var current = (ctx.getState().config || {}).port;
    if (port === current) {
      ui.showSnackbar('端口没有变化');
      return;
    }
    root.LinkOK.api.patchConfig({ port: port }).then(function (result) {
      if (!result.ok) {
        ui.showSnackbar(result.message, { duration: 6000 });
        return;
      }
      ctx.setPendingPort(null);
      ctx.applyConfig(result.data);
      ui.showSnackbar('端口已改为 ' + port + '，重启 Hub 后生效', { duration: 6000 });
      ctx.render();
    });
  }

  function applyToggle(ctx, button, key, next) {
    var ui = root.LinkOK.ui;
    var patch;
    if (key.indexOf('.') !== -1) {
      var parts = key.split('.');
      patch = {};
      patch[parts[0]] = {};
      patch[parts[0]][parts[1]] = next;
    } else {
      patch = {};
      patch[key] = next;
    }

    var previous = button.getAttribute('aria-checked');
    button.setAttribute('aria-checked', next ? 'true' : 'false');
    button.disabled = true;

    root.LinkOK.api.patchConfig(patch).then(function (result) {
      button.disabled = false;
      if (!result.ok) {
        button.setAttribute('aria-checked', previous);
        ui.showSnackbar(result.message, { duration: 6000 });
        return;
      }
      ctx.applyConfig(result.data);
      // Notification switches disable/enable each other, so a repaint is needed.
      if (key === 'notifications.enabled') {
        ctx.render();
      } else {
        ui.showSnackbar(next ? '已打开' : '已关闭');
      }
    });
  }

  function applyRetention(ctx, value, input) {
    var ui = root.LinkOK.ui;
    root.LinkOK.api.patchConfig({ retentionDays: value }).then(function (result) {
      if (!result.ok) {
        ui.showSnackbar(result.message, { duration: 6000 });
        // Put the radio back on whatever the Hub still has.
        var current = String((ctx.getState().config || {}).retentionDays);
        var still = input.form ? input.form.querySelector('input[value="' + current + '"]') : null;
        if (still) still.checked = true;
        return;
      }
      ctx.applyConfig(result.data);
      ui.showSnackbar(value === 0 ? '保留期改为永不' : '保留期改为 ' + value + ' 天');
    });
  }

  views.settings = {
    title: '设置',
    mount: settingsView
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
