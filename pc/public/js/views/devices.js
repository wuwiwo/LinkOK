/* LinkOK — 设备 (devices) and the pairing dialog.
 *
 * Pairing per PROTOCOL §6.1: the Hub mints a one-time code and returns the exact
 * `qrPayload` the phone expects. We render that payload as a QR client-side
 * (js/qr.js) so the page needs no CDN and works with the network unplugged from
 * the internet. The code is also shown as text, because a QR alone is unusable
 * if the phone's camera is unavailable or the user is reading it aloud.
 *
 * The dialog owns a countdown: a pairing code is valid for 120 seconds
 * (SPEC §5.5) and the UI must show that it is expiring rather than let the user
 * scan a dead code.
 */
(function (root) {
  'use strict';

  var views = (root.LinkOK = root.LinkOK || {}).views || (root.LinkOK.views = {});

  function esc(value) {
    return root.LinkOK.util.escapeHtml(value);
  }

  function deviceRow(device) {
    var util = root.LinkOK.util;
    var model = device.deviceModel ? device.deviceModel : '';
    var sub = [model, device.current ? '当前连接' : ''].filter(Boolean).join(' · ');
    var pairedAt = device.pairedAt ? util.formatRelative(device.pairedAt) : '';
    return (
      '<li class="list-item">' +
      '<span class="list-item__leading" data-icon="phone" aria-hidden="true"></span>' +
      '<div class="list-item__body">' +
      '<p class="list-item__title">' + esc(device.deviceName || '手机') + '</p>' +
      '<p class="list-item__sub">' + esc(sub || '已配对') +
      (pairedAt ? ' · 配对于 ' + esc(pairedAt) : '') +
      '</p>' +
      '</div>' +
      '<span class="list-item__trailing">' +
      (device.current
        ? '<span class="status-dot status-dot--on" aria-hidden="true"></span><span>在线</span>'
        : '<span class="status-dot" aria-hidden="true"></span><span>离线</span>') +
      '</span>' +
      '</li>'
    );
  }

  /** The demo/Hub-optional device list, normalised from whatever we got. */
  function normaliseDevices(state, pairingsResult) {
    var list = [];
    if (pairingsResult && pairingsResult.ok && pairingsResult.data && Array.isArray(pairingsResult.data.devices)) {
      return pairingsResult.data.devices.map(function (d) {
        return {
          deviceName: d.deviceName || d.name || '手机',
          deviceModel: d.deviceModel || d.model || '',
          pairedAt: d.pairedAt || null,
          current: Boolean(d.current)
        };
      });
    }
    // Fall back to the single device in /api/state. That is all the base
    // contract guarantees, and it is enough for a one-phone setup.
    if (state && state.paired && state.connection && state.connection.deviceName) {
      list.push({
        deviceName: state.connection.deviceName,
        deviceModel: '',
        pairedAt: null,
        current: Boolean(state.connection.connected)
      });
    }
    return list;
  }

  var pairing = {
    /**
     * Ask the Hub for a code and show the QR dialog. Failure is reported in the
     * dialog itself, not in a transient toast, because the user has already
     * committed to "pair a new device" and needs to know why it stopped.
     */
    open: function (ctx) {
      var ui = root.LinkOK.ui;
      var util = root.LinkOK.util;
      var api = root.LinkOK.api;

      var handle = ui.openModal({
        title: '配对新设备',
        body:
          '<p class="dialog__body">正在生成配对码…</p>' +
          '<div class="qr-plate" data-qr-plate hidden><canvas data-qr width="208" height="208"></canvas></div>',
        footer: '<button class="btn btn--text" type="button" data-close-dialog>关闭</button>'
      });

      api.createPairingCode().then(function (result) {
        if (!handle.dialog || !handle.dialog.isConnected) return;

        var bodyHost = handle.dialog.querySelector('.dialog__body-host');
        if (!result.ok) {
          bodyHost.innerHTML =
            '<div class="banner banner--error" role="alert">' +
            '<span class="list-item__leading" data-icon="alert" aria-hidden="true"></span>' +
            '<div class="banner__body">' +
            '<p class="banner__title">生成配对码失败</p>' +
            '<p class="banner__text">' + esc(result.message) + '</p>' +
            '</div></div>';
          ui.hydrateIcons(bodyHost);
          return;
        }

        var data = result.data || {};
        var state = ctx.getState() || {};
        var port = (state.config && state.config.port) || 8787;
        var host = state.host || (root.location ? root.location.hostname : '');
        var payload =
          data.qrPayload ||
          util.buildPairPayload({
            host: host,
            port: port,
            code: data.code || '',
            fp: state.fp || ''
          });

        var expiresAt = data.expiresAt || new Date(Date.now() + 120000).toISOString();
        var loopback = util.isLoopbackHost(host);

        bodyHost.innerHTML =
          '<p class="dialog__body">用手机上的 LinkOK 扫描这个二维码。配对码两分钟内有效，只能用一次。</p>' +
          '<div class="qr-plate"><canvas data-qr width="208" height="208" aria-label="配对新设备的二维码"></canvas></div>' +
          '<div class="dialog__code">' +
          '<span class="field__label">配对码</span>' +
          '<span class="code-value" data-code>' + esc(data.code || '—') + '</span>' +
          '</div>' +
          '<p class="countdown" data-countdown role="timer" aria-live="off"></p>' +
          (loopback
            ? '<p class="dialog__body">这个二维码指向本机地址，手机无法访问。' +
              '请让 Hub 返回局域网地址，或用手机能访问的地址打开设置页后再配对。</p>'
            : '') +
          '<details style="width:100%;text-align:left">' +
          '<summary class="field__label" style="cursor:pointer">扫描不了？手动输入</summary>' +
          '<p class="code-value" data-payload style="margin:var(--sp-2) 0 0">' + esc(payload) + '</p>' +
          '</details>';

        var canvas = bodyHost.querySelector('[data-qr]');
        try {
          root.LinkOK.qr.draw(canvas, payload, {
            size: 208,
            ecl: 'M',
            label: '配对新设备的二维码',
            // Force the light plate in both schemes; a dark QR on a dark plate
            // scans badly on phones that auto-expose for the bright rectangle.
            dark: '#101418',
            light: '#ffffff'
          });
        } catch (err) {
          var plate = bodyHost.querySelector('.qr-plate');
          if (plate) {
            plate.innerHTML =
              '<p class="dialog__body">这台浏览器没能生成二维码。请手动输入下面的内容。</p>';
          }
        }

        // ---- countdown
        var countdownNode = bodyHost.querySelector('[data-countdown]');
        var timer = root.setInterval(function () {
          if (!countdownNode || !countdownNode.isConnected) {
            root.clearInterval(timer);
            return;
          }
          var left = util.secondsUntil(expiresAt);
          if (left <= 0) {
            countdownNode.textContent = '配对码已过期，重新打开这个窗口可以再生成一个。';
            var canvasEl = bodyHost.querySelector('[data-qr]');
            var plateEl = bodyHost.querySelector('.qr-plate');
            if (plateEl && canvasEl) {
              plateEl.classList.add('qr-plate--expired');
              plateEl.innerHTML = '<p class="dialog__body">配对码已过期</p>';
            }
            root.clearInterval(timer);
            return;
          }
          countdownNode.textContent = '还剩 ' + util.formatCountdown(left);
        }, 1000);

        handle.dialog.addEventListener('remove', function () {
          root.clearInterval(timer);
        });
        // <dialog> is removed by ui.closeModal; poll cheaply for detachment.
        var watch = root.setInterval(function () {
          if (!handle.dialog.isConnected) {
            root.clearInterval(timer);
            root.clearInterval(watch);
          }
        }, 1000);
      });
    }
  };

  views.devices = {
    title: '设备',
    mount: function (container, ctx) {
      var ui = root.LinkOK.ui;
      var state = ctx.getState();
      var error = ctx.getError();
      var devices = normaliseDevices(state, ctx.getPairings());
      var connected = Boolean(state && state.connection && state.connection.connected);

      if (!state) {
        ui.renderInto(
          container,
          '<header class="page-head"><h1 class="page-head__title">设备</h1></header>' +
            '<div class="banner banner--error" role="alert">' +
            '<span class="list-item__leading" data-icon="alert" aria-hidden="true"></span>' +
            '<div class="banner__body">' +
            '<p class="banner__title">读不到设备信息</p>' +
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

      var listHtml;
      if (devices.length === 0) {
        listHtml =
          '<div class="empty">' +
          '<span class="empty__icon" data-icon="phone" aria-hidden="true"></span>' +
          '<p class="empty__title">还没有配对的手机</p>' +
          '<p class="empty__body">在手机上打开 LinkOK，扫描下一屏出现的二维码，就能把这台电脑和手机连起来。</p>' +
          '<div class="actions-row" style="margin-top: var(--sp-2)">' +
          '<button class="btn btn--filled" type="button" data-action="pair">配对新设备</button>' +
          '</div>' +
          '</div>';
      } else {
        listHtml = '<ul class="list">' + devices.map(deviceRow).join('') + '</ul>';
      }

      ui.renderInto(
        container,
        '<header class="page-head">' +
          '<h1 class="page-head__title">设备</h1>' +
          '<p class="page-head__meta">' + (devices.length ? devices.length + ' 台已配对' : '未配对') + '</p>' +
          '</header>' +
          '<h2 class="section-title">已配对</h2>' +
          listHtml +
          '<h2 class="section-title">配对</h2>' +
          '<ul class="list">' +
          '<li class="list-item">' +
          '<span class="list-item__leading" data-icon="qr" aria-hidden="true"></span>' +
          '<div class="list-item__body">' +
          '<p class="list-item__title">配对新设备</p>' +
          '<p class="list-item__sub">生成一个两分钟有效的二维码，用手机扫描</p>' +
          '</div>' +
          '<button class="btn btn--outlined" type="button" data-action="pair">配对新设备</button>' +
          '</li>' +
          '</ul>' +
          '<h2 class="section-title">连接</h2>' +
          '<ul class="list">' +
          '<li class="list-item">' +
          '<span class="list-item__leading" data-icon="' + (connected ? 'check' : 'alert') + '" aria-hidden="true"></span>' +
          '<div class="list-item__body">' +
          '<p class="list-item__title">' + (connected ? '手机已连接' : '手机未连接') + '</p>' +
          '<p class="list-item__sub">' +
          (connected
            ? '截图和剪贴板会实时同步。'
            : '手机不在线时，电脑上的截图会先存在 History 里，等手机连上再处理。') +
          '</p>' +
          '</div>' +
          '</li>' +
          '</ul>' +
          '<div class="actions-row">' +
          '<button class="btn btn--outlined btn--danger" type="button" data-action="revoke">' +
          root.LinkOK.icons.svg('revoke', { size: 18 }) + '吊销已配对的手机' +
          '</button>' +
          '</div>'
      );

      ui.delegate(container, 'click', {
        pair: function () {
          pairing.open(ctx);
        },
        revoke: function () {
          ui.openModal({
            title: '吊销配对？',
            body:
              '<p class="dialog__body">手机会立刻失去访问权限，需要重新扫二维码才能再连上。' +
              '这台电脑保存的截图历史不会受影响。</p>',
            footer:
              '<button class="btn btn--text" type="button" data-close-dialog>取消</button>' +
              '<button class="btn btn--filled" type="button" data-confirm>吊销</button>',
            onMount: function (dialog) {
              dialog.querySelector('[data-confirm]').addEventListener('click', function () {
                ui.closeModal();
                root.LinkOK.api.revokeDevice().then(function (result) {
                  if (!result.ok) {
                    ui.showSnackbar(result.message, { duration: 6000 });
                    return;
                  }
                  ui.showSnackbar('已吊销配对');
                  ctx.reload();
                });
              });
            }
          });
        }
      });
    }
  };

  root.LinkOK.pairing = pairing;
})(typeof globalThis !== 'undefined' ? globalThis : this);
