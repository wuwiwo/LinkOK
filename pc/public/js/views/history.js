/* LinkOK — 历史 (history)
 *
 * Grouped by local date, newest first. Every row is a flat ListItem; there are no
 * cards in this view. Row actions are icon buttons with aria-labels, not a
 * floating menu, because there are exactly three and they are self-describing.
 *
 * "复制到剪贴板" cannot be done by the browser on a LAN origin: `navigator.clipboard`
 * requires a secure context and `http://192.168.x.x` is not one. The primary path
 * is therefore `POST /api/history/:id/copy` (the Hub writes to the Windows
 * clipboard). The browser API is only attempted when it is actually available,
 * and if neither works the user is told what happened and offered the raw image.
 */
(function (root) {
  'use strict';

  var views = (root.LinkOK = root.LinkOK || {}).views || (root.LinkOK.views = {});

  function esc(value) {
    return root.LinkOK.util.escapeHtml(value);
  }

  function thumbnail(item) {
    var util = root.LinkOK.util;
    var src = item.thumb || root.LinkOK.api.rawUrl(item.id);
    if (!src) {
      return (
        '<span class="thumb thumb--empty" aria-hidden="true">' +
        root.LinkOK.icons.svg('image', { size: 20 }) +
        '</span>'
      );
    }
    var alt = '截图预览，' + util.sourceLabel(item.source) + '，' + util.formatTime(item.arrivedAt);
    return (
      '<img class="thumb" src="' + esc(src) + '" alt="' + esc(alt) + '"' +
      ' width="56" height="56" loading="lazy" decoding="async" />'
    );
  }

  function row(item) {
    var util = root.LinkOK.util;
    var dims = util.formatDimensions(item.width, item.height);
    var meta = [util.formatTime(item.arrivedAt), util.sourceShort(item.source), util.formatBytes(item.bytes)];
    if (dims) meta.push(dims);

    return (
      '<li class="list-item list-item--start">' +
      thumbnail(item) +
      '<div class="list-item__body">' +
      '<p class="list-item__title tnum">' + esc(util.formatTime(item.arrivedAt)) + '</p>' +
      '<p class="list-item__sub">' +
      esc(meta.slice(1).join(' · ')) +
      '</p>' +
      '</div>' +
      '<div class="list-item__trailing">' +
      '<button class="icon-btn" type="button" data-action="copy" data-id="' + esc(item.id) + '"' +
      ' aria-label="复制 ' + esc(util.formatTime(item.arrivedAt)) + ' 的截图到剪贴板" title="复制到剪贴板">' +
      root.LinkOK.icons.svg('copy', { size: 20 }) +
      '</button>' +
      '<button class="icon-btn" type="button" data-action="reveal" data-id="' + esc(item.id) + '"' +
      ' aria-label="在文件夹中显示 ' + esc(util.formatTime(item.arrivedAt)) + ' 的截图" title="在文件夹中显示">' +
      root.LinkOK.icons.svg('folder', { size: 20 }) +
      '</button>' +
      '<button class="icon-btn icon-btn--danger" type="button" data-action="delete" data-id="' + esc(item.id) + '"' +
      ' aria-label="删除 ' + esc(util.formatTime(item.arrivedAt)) + ' 的截图" title="删除">' +
      root.LinkOK.icons.svg('trash', { size: 20 }) +
      '</button>' +
      '</div>' +
      '</li>'
    );
  }

  function renderGroups(items, now) {
    var util = root.LinkOK.util;
    var groups = util.groupByDay(items, now);
    var html = '';
    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      html +=
        '<h2 class="group-head">' +
        '<span>' + esc(group.label) + '</span>' +
        '<span class="group-head__count">' + group.items.length + ' 张</span>' +
        '</h2>' +
        '<ul class="list">' +
        group.items.map(row).join('') +
        '</ul>';
    }
    return html;
  }

  function emptyState() {
    return (
      '<div class="empty">' +
      '<span class="empty__icon" data-icon="image" aria-hidden="true"></span>' +
      '<p class="empty__title">还没有截图</p>' +
      '<p class="empty__body">在手机或电脑上截一张图，LinkOK 会自动把它收进来。' +
      '也可以先在电脑上复制一张图片试试。</p>' +
      '<div class="actions-row" style="margin-top: var(--sp-2)">' +
      '<a class="btn btn--outlined" href="#/devices">检查手机是否已配对</a>' +
      '</div>' +
      '</div>'
    );
  }

  /** Demo-mode delete confirmation, in place of a browser confirm() dialog. */
  function confirmDelete(ctx, item, done) {
    var util = root.LinkOK.util;
    root.LinkOK.ui.openModal({
      title: '删除这张截图？',
      body:
        '<p class="dialog__body">' +
        '只会删掉 LinkOK 自己保存的这份副本（' + esc(util.formatTime(item.arrivedAt)) + '，' +
        esc(util.sourceShort(item.source)) + '）。手机相册和你自己的截图文件夹不受影响。' +
        '</p>',
      footer:
        '<button class="btn btn--text" type="button" data-close-dialog>取消</button>' +
        '<button class="btn btn--filled" type="button" data-confirm>删除</button>',
      onMount: function (dialog, handle) {
        dialog.querySelector('[data-confirm]').addEventListener('click', function () {
          handle.close();
          done();
        });
      }
    });
  }

  /**
   * Copy via the Hub (authoritative). If the Hub does not implement the endpoint
   * we say so plainly instead of silently failing.
   */
  function copyItem(ctx, item) {
    var ui = root.LinkOK.ui;
    root.LinkOK.api.copyToClipboard(item.id).then(function (result) {
      if (result.ok) {
        ui.showSnackbar('已复制到剪贴板');
        return;
      }
      if (result.status === 404) {
        ui.showSnackbar('Hub 还不支持从网页复制。在历史里右键「在文件夹中显示」可以拿到原图。', {
          duration: 7000
        });
        return;
      }
      ui.showSnackbar(result.message, { duration: 6000 });
    });
  }

  function revealItem(ctx, item) {
    var ui = root.LinkOK.ui;
    root.LinkOK.api.reveal({ target: 'history', id: item.id }).then(function (result) {
      if (result.ok) return;
      if (result.status === 404) {
        ui.showSnackbar('Hub 还不支持打开文件夹。文件在 PC History 目录里。', { duration: 7000 });
        return;
      }
      ui.showSnackbar(result.message, { duration: 6000 });
    });
  }

  function deleteItem(ctx, item) {
    var ui = root.LinkOK.ui;
    confirmDelete(ctx, item, function () {
      root.LinkOK.api.deleteHistory(item.id).then(function (result) {
        if (!result.ok) {
          ui.showSnackbar(result.message, { duration: 6000 });
          return;
        }
        ui.showSnackbar('已删除');
        ctx.reload();
      });
    });
  }

  views.history = {
    title: '历史',
    mount: function (container, ctx) {
      var ui = root.LinkOK.ui;
      var state = ctx.getState();
      var error = ctx.getError();
      var items = ctx.getHistoryItems();
      var loading = ctx.isHistoryLoading();

      if (!state && !loading) {
        ui.renderInto(
          container,
          '<header class="page-head"><h1 class="page-head__title">历史</h1></header>' +
            '<div class="banner banner--error" role="alert">' +
            '<span class="list-item__leading" data-icon="alert" aria-hidden="true"></span>' +
            '<div class="banner__body">' +
            '<p class="banner__title">读不到历史</p>' +
            '<p class="banner__text">' + esc((error && error.message) || 'Hub 没有响应。') + '</p>' +
            '<div class="banner__actions">' +
            '<button class="btn btn--outlined" type="button" data-action="retry">重试</button>' +
            '<button class="btn btn--text" type="button" data-action="demo">用演示数据看看</button>' +
            '</div>' +
            '</div></div>'
        );
        ui.delegate(container, 'click', {
          retry: function () { ctx.reload(); },
          demo: function () { ctx.enterDemo(); }
        });
        return;
      }

      if (!items) {
        ui.renderInto(
          container,
          '<header class="page-head"><h1 class="page-head__title">历史</h1></header>' +
            '<p class="loading" role="status">正在读取历史…</p>'
        );
        return;
      }

      var now = new Date();
      var body = items.length === 0 ? emptyState() : renderGroups(items, now);

      ui.renderInto(
        container,
        '<header class="page-head">' +
          '<h1 class="page-head__title">历史</h1>' +
          (items.length
            ? '<p class="page-head__meta tnum">' + items.length + ' 张</p>'
            : '<p class="page-head__meta">' + (ctx.isDemo() ? '演示数据' : '') + '</p>') +
          '</header>' +
          (ctx.isDemo()
            ? '<div class="banner banner--info" style="margin-bottom: var(--sp-4)">' +
              '<span class="list-item__leading" data-icon="info" aria-hidden="true"></span>' +
              '<div class="banner__body"><p class="banner__text">演示数据。删除只在本次会话内生效。</p></div>' +
              '</div>'
            : '') +
          body
      );

      // A broken thumbnail must not leave a grey void: swap in the placeholder.
      var images = container.querySelectorAll('img.thumb');
      for (var i = 0; i < images.length; i++) {
        images[i].addEventListener('error', function (event) {
          var img = event.currentTarget;
          var placeholder = root.document.createElement('span');
          placeholder.className = 'thumb thumb--empty';
          placeholder.setAttribute('aria-hidden', 'true');
          placeholder.innerHTML = root.LinkOK.icons.svg('image', { size: 20 });
          if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
        });
      }

      ui.delegate(container, 'click', {
        copy: function (button) {
          var item = ctx.findHistoryItem(button.getAttribute('data-id'));
          if (item) copyItem(ctx, item);
        },
        reveal: function (button) {
          var item = ctx.findHistoryItem(button.getAttribute('data-id'));
          if (item) revealItem(ctx, item);
        },
        delete: function (button) {
          var item = ctx.findHistoryItem(button.getAttribute('data-id'));
          if (item) deleteItem(ctx, item);
        }
      });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
