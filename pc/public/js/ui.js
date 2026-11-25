/* LinkOK — UI primitives shared by the views.
 *
 * Everything here is deliberately small: a snackbar, a modal dialog helper, and
 * icon hydration. There is no component framework, no virtual DOM and no
 * templating language; views return HTML strings and attach explicit listeners.
 *
 * Accessibility rules enforced here:
 *   - icons are always aria-hidden, and every icon-only control is required to
 *     carry an aria-label (asserted by the verifier)
 *   - the snackbar is a polite live region; it never steals focus
 *   - the dialog traps focus via <dialog> and restores it on close
 */
(function (root) {
  'use strict';

  var doc = root.document;

  function icons() {
    return root.LinkOK.icons;
  }

  /** Replace every `[data-icon]` placeholder with its inline SVG. */
  function hydrateIcons(scope) {
    var host = scope || doc;
    var slots = host.querySelectorAll('[data-icon]');
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      var name = slot.getAttribute('data-icon');
      var size = Number(slot.getAttribute('data-icon-size')) || 24;
      slot.innerHTML = icons().svg(name, { size: size });
      slot.removeAttribute('data-icon');
    }
  }

  // ------------------------------------------------------------- snackbar

  var snackTimer = null;

  /**
   * showSnackbar('已复制', { action: { label: '撤销', onSelect } })
   * Exactly one snackbar exists, so a new call replaces the current one.
   */
  function showSnackbar(message, options) {
    options = options || {};
    var bar = doc.getElementById('snackbar');
    var text = doc.getElementById('snackbar-text');
    var action = doc.getElementById('snackbar-action');
    if (!bar || !text || !action) return;

    text.textContent = message;
    bar.hidden = false;

    if (options.action && options.action.label) {
      action.hidden = false;
      action.textContent = options.action.label;
      action.onclick = function () {
        hideSnackbar();
        if (typeof options.action.onSelect === 'function') options.action.onSelect();
      };
    } else {
      action.hidden = true;
      action.onclick = null;
      action.textContent = '';
    }

    if (snackTimer) root.clearTimeout(snackTimer);
    var duration = options.duration == null ? 4200 : options.duration;
    if (duration > 0) {
      snackTimer = root.setTimeout(hideSnackbar, duration);
    }
  }

  function hideSnackbar() {
    var bar = doc.getElementById('snackbar');
    if (bar) bar.hidden = true;
    if (snackTimer) {
      root.clearTimeout(snackTimer);
      snackTimer = null;
    }
  }

  // --------------------------------------------------------------- dialog

  var openDialog = null;

  /**
   * openModal({ title, body, footer, onMount, onClose }) -> { close }
   * `body` and `footer` are HTML strings supplied by the caller; the caller is
   * responsible for escaping anything that came off the wire.
   */
  function openModal(config) {
    closeModal();
    var host = doc.getElementById('dialog-root');
    if (!host) return { close: function () {} };

    var dialog = doc.createElement('dialog');
    dialog.className = 'dialog';
    dialog.innerHTML =
      '<div class="dialog__panel">' +
      '<h2 class="dialog__title" id="dialog-title">' + (config.title || '') + '</h2>' +
      '<div class="dialog__body-host">' + (config.body || '') + '</div>' +
      (config.footer ? '<div class="dialog__foot">' + config.footer + '</div>' : '') +
      '</div>';
    dialog.setAttribute('aria-labelledby', 'dialog-title');
    host.appendChild(dialog);

    // Prefer the native modal (focus trap + Escape for free). jsdom and very
    // old browsers may not implement showModal; fall back to the open attribute.
    if (typeof dialog.showModal === 'function') {
      try {
        dialog.showModal();
      } catch (e) {
        dialog.setAttribute('open', '');
      }
    } else {
      dialog.setAttribute('open', '');
    }

    function close() {
      if (!dialog.isConnected) return;
      if (typeof dialog.close === 'function' && dialog.open) {
        try { dialog.close(); } catch (e) { /* ignore */ }
      }
      if (dialog.parentNode) dialog.parentNode.removeChild(dialog);
      if (openDialog === handle) openDialog = null;
      if (typeof config.onClose === 'function') config.onClose();
    }

    // Close on backdrop click. Clicks inside .dialog__panel never reach here.
    dialog.addEventListener('click', function (event) {
      if (event.target === dialog) close();
    });
    dialog.addEventListener('cancel', function (event) {
      event.preventDefault();
      close();
    });
    // Any element with data-close-dialog closes it (wired per click, since the
    // footer markup is caller-supplied and may be re-rendered).
    dialog.addEventListener('click', function (event) {
      var target = event.target;
      while (target && target !== dialog) {
        if (target.hasAttribute && target.hasAttribute('data-close-dialog')) {
          close();
          return;
        }
        target = target.parentNode;
      }
    });

    var handle = { dialog: dialog, close: close };
    openDialog = handle;
    hydrateIcons(dialog);
    if (typeof config.onMount === 'function') config.onMount(dialog, handle);
    return handle;
  }

  function closeModal() {
    if (openDialog) openDialog.close();
  }

  function currentModal() {
    return openDialog;
  }

  // ----------------------------------------------------------- dom helpers

  /** Build an element with attributes and children in one call. */
  function el(tag, attrs, children) {
    var node = doc.createElement(tag);
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
        var value = attrs[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.indexOf('on') === 0 && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value === true ? '' : value);
      }
    }
    if (children) {
      for (var i = 0; i < children.length; i++) if (children[i]) node.appendChild(children[i]);
    }
    return node;
  }

  /**
   * Attach one delegated listener for `eventType` on `host`, dispatching to the
   * closest element carrying `data-action`. Views stay declarative: markup says
   * data-action="copy" data-id="…", and one handler routes it.
   */
  function delegate(host, eventType, handlers) {
    host.addEventListener(eventType, function (event) {
      var target = event.target;
      while (target && target !== host) {
        if (target.getAttribute) {
          var action = target.getAttribute('data-action');
          if (action && Object.prototype.hasOwnProperty.call(handlers, action)) {
            event.preventDefault();
            handlers[action](target, event);
            return;
          }
        }
        target = target.parentNode;
      }
    });
  }

  /** Replace a container's content and hydrate any icons inside it. */
  function renderInto(container, html) {
    container.innerHTML = html;
    hydrateIcons(container);
    return container;
  }

  root.LinkOK = root.LinkOK || {};
  root.LinkOK.ui = {
    hydrateIcons: hydrateIcons,
    showSnackbar: showSnackbar,
    hideSnackbar: hideSnackbar,
    openModal: openModal,
    closeModal: closeModal,
    currentModal: currentModal,
    el: el,
    delegate: delegate,
    renderInto: renderInto
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
