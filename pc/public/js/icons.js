/* LinkOK — icon set
 *
 * Material Symbols geometry, hand-inlined as path data so the page has no
 * network dependency and no icon font. Every icon is drawn on a 24×24 grid
 * with a 1.75 stroke at 24px, matching the "regular text next to the icon"
 * row in DESIGN-GUIDE §6. Icons inherit `currentColor`.
 *
 * Usage from markup: <span data-icon="history"></span> (ui.hydrateIcons)
 * Usage from JS:      LinkOK.icons.svg('history', { size: 20 })
 */
(function (root) {
  'use strict';

  // name -> inner SVG markup, drawn inside a 24x24 viewBox.
  var PATHS = {
    overview:
      '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/>' +
      '<rect x="13.5" y="3.5" width="7" height="7" rx="2"/>' +
      '<rect x="3.5" y="13.5" width="7" height="7" rx="2"/>' +
      '<rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
    history:
      '<circle cx="12" cy="12" r="8.5"/>' +
      '<path d="M12 7.5v5l3.2 2"/>',
    devices:
      '<rect x="2.5" y="4.5" width="12" height="8.5" rx="1.5"/>' +
      '<path d="M6 17.5h5"/>' +
      '<rect x="17" y="8" width="4.5" height="11.5" rx="1.5"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M17.9 6.1l-1.4 1.4M7.5 16.5l-1.4 1.4M17.9 17.9l-1.4-1.4M7.5 7.5L6.1 6.1"/>',
    pc:
      '<rect x="2.5" y="4.5" width="19" height="12" rx="2"/>' +
      '<path d="M8.5 20.5h7M12 16.5v4"/>',
    phone:
      '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/>' +
      '<path d="M11 18.5h2"/>',
    image:
      '<rect x="3" y="4.5" width="18" height="15" rx="2"/>' +
      '<circle cx="8.5" cy="9.5" r="1.5"/>' +
      '<path d="M3.5 16.5l4.5-4 4 3.5 3-2.5 5 4.5"/>',
    copy:
      '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/>' +
      '<path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
    folder:
      '<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2a2 2 0 0 1 1.5.7l1 1.3h7.3a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z"/>',
    trash:
      '<path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/>' +
      '<path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/>' +
      '<path d="M10 10.5v6M14 10.5v6"/>',
    qr:
      '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/>' +
      '<rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/>' +
      '<rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/>' +
      '<path d="M14 14h3v3h-3zM20.5 14v0M20.5 20.5v0M17 20.5v0M14 20.5v0"/>',
    pause:
      '<rect x="7" y="5" width="3.5" height="14" rx="1.2"/>' +
      '<rect x="13.5" y="5" width="3.5" height="14" rx="1.2"/>',
    play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11-7.2a.8.8 0 0 0 0-1.4l-11-7.2a.8.8 0 0 0-1.2.7z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    check: '<path d="M4.5 12.5l5 5 10-10.5"/>',
    alert:
      '<path d="M12 3.8l8.5 15.4a1 1 0 0 1-.9 1.5H4.4a1 1 0 0 1-.9-1.5z"/>' +
      '<path d="M12 9v4.5M12 16.5v0"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v0"/>',
    refresh:
      '<path d="M20 12a8 8 0 1 1-2.6-5.9"/>' +
      '<path d="M20 4.5V10h-5.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    revoke:
      '<path d="M9 4.5h9a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9"/>' +
      '<path d="M13.5 12H4M7 8.5L3.5 12 7 15.5"/>',
    bell:
      '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z"/>' +
      '<path d="M10 18.8a2.2 2.2 0 0 0 4 0"/>',
    power:
      '<path d="M12 3.5V11"/>' +
      '<path d="M7.2 6.6a7.5 7.5 0 1 0 9.6 0"/>',
    storage:
      '<path d="M4.5 6.5A2 2 0 0 1 6.5 4.5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"/>' +
      '<path d="M4.5 13.5h15"/>' +
      '<path d="M8 16.8v0M11.5 16.8v0"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12h3.5"/>'
  };

  /**
   * Build an <svg> string. `opts.size` sets width/height; `opts.className`
   * appends a class. The svg is always aria-hidden: the accessible name comes
   * from the button's aria-label or from adjacent text, never from the icon.
   */
  function svg(name, opts) {
    opts = opts || {};
    var inner = PATHS[name];
    if (!inner) {
      if (root.console) console.warn('[linkok] unknown icon:', name);
      return '';
    }
    var size = opts.size || 24;
    var cls = 'icon' + (opts.className ? ' ' + opts.className : '');
    return (
      '<svg class="' + cls + '" viewBox="0 0 24 24" width="' + size + '" height="' + size + '"' +
      ' fill="none" stroke="currentColor" stroke-width="1.75"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      inner +
      '</svg>'
    );
  }

  root.LinkOK = root.LinkOK || {};
  root.LinkOK.icons = { svg: svg, names: Object.keys(PATHS) };
})(typeof globalThis !== 'undefined' ? globalThis : this);
