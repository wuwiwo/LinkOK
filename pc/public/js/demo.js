/* LinkOK — demo fixtures.
 *
 * Used only when `?demo=1` is present, or when the Hub cannot be reached and the
 * reviewer asked for demo mode. The shapes match PROTOCOL §4 / §7 exactly, so
 * the views cannot tell demo data from live data — if they could, the views
 * would be special-casing something the Hub is allowed to send.
 *
 * Timestamps are generated relative to "now" so the date grouping, 今天/昨天
 * headers and relative times are all exercised no matter when the page is
 * opened.
 */
(function (root) {
  'use strict';

  var util = root.LinkOK.util;

  // ------------------------------------------------------------- thumbnails
  // A Capture thumbnail in demo mode is an inline SVG that reads as a phone
  // screenshot at 56px: a status bar, a header block and a few content rows.
  // Generated, not fetched — the page must work with no network at all.
  function makeThumb(kind, seed) {
    var palettes = {
      phone: ['#dbe4f3', '#8fa9d6', '#3f5f96', '#eef2f9'],
      pc: ['#e3e7ee', '#a9b4c6', '#41506b', '#f3f5f8'],
      light: ['#eef0f4', '#c3c9d4', '#5b6472', '#fafbfc']
    };
    var p = palettes[kind] || palettes.light;
    var rows = '';
    for (var i = 0; i < 4; i++) {
      var w = 26 + ((seed * (i + 3) * 7) % 30);
      rows +=
        '<rect x="9" y="' + (22 + i * 10) + '" width="' + w + '" height="5" rx="2.5" fill="' + p[1] + '"/>';
    }
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
      '<rect width="64" height="64" fill="' + p[3] + '"/>' +
      '<rect x="0" y="0" width="64" height="8" fill="' + p[0] + '"/>' +
      '<rect x="9" y="11" width="' + (20 + (seed % 14)) + '" height="7" rx="3.5" fill="' + p[2] + '"/>' +
      rows +
      '</svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  var SOURCES = ['phone', 'phone', 'phone', 'pc-clipboard', 'pc-folder', 'phone'];

  function hash(seed) {
    var hex = '0123456789abcdef';
    var out = '';
    for (var i = 0; i < 64; i++) {
      out += hex[(seed * 31 + i * 17 + (i * i) % 11) % 16];
    }
    return out;
  }

  // Build a HistoryItem id the way PROTOCOL §4 requires: compact UTC, no colons,
  // followed by the first six hex characters of the hash.
  function makeId(date, h) {
    var iso = date.toISOString(); // 2026-11-25T08:46:51.132Z
    var compact = iso.replace(/[-:.]/g, '').replace('Z', '');
    return compact + '-' + h.slice(0, 6);
  }

  function makeHistory(now) {
    var layouts = [
      [0, 16, 46, 12, 1080, 2400],
      [0, 15, 2, 8, 2400, 1080],
      [0, 11, 24, 5, 1080, 2400],
      [0, 9, 51, 3, 1440, 3120],
      [1, 20, 12, 6, 1080, 2400],
      [1, 18, 40, 2, 2400, 1080],
      [1, 8, 15, 4, 1080, 2400],
      [2, 21, 3, 7, 1080, 2400],
      [2, 17, 30, 1, 1920, 1080],
      [4, 14, 22, 9, 1080, 2400],
      [6, 10, 5, 3, 1080, 2400],
      [9, 19, 48, 11, 1440, 2960]
    ];

    var items = [];
    for (var i = 0; i < layouts.length; i++) {
      var spec = layouts[i];
      var when = new Date(now.getTime());
      when.setDate(when.getDate() - spec[0]);
      when.setHours(spec[1], spec[2], spec[3], 0);

      var h = hash(i + 1);
      var source = SOURCES[i % SOURCES.length];
      var width = spec[4];
      var height = spec[5];
      var bytes = 180000 + ((i * 91731) % 780000);

      items.push({
        id: makeId(when, h),
        sha256: h,
        source: source,
        arrivedAt: when.toISOString(),
        file:
          util.dayKey(when.toISOString()) +
          '/' +
          makeId(when, h) +
          '.png',
        bytes: bytes,
        width: width,
        height: height,
        // Demo only: the real API serves bytes at /api/history/:id/raw. Views
        // prefer item.thumb when present so demo mode needs no server.
        thumb: makeThumb(source === 'phone' ? 'phone' : 'pc', i + 2)
      });
    }

    items.sort(function (a, b) {
      return new Date(b.arrivedAt) - new Date(a.arrivedAt);
    });
    return items;
  }

  function makeState(now) {
    var since = new Date(now.getTime() - 1000 * 60 * 137); // 2h17m ago
    return {
      config: {
        port: 8787,
        retentionDays: 30,
        notifications: {
          enabled: true,
          captureDelivered: true,
          clipboardSynced: false,
          errors: true
        },
        autostart: true,
        screenshotDir: 'E:\\download'
      },
      connection: {
        connected: true,
        deviceName: 'Redmi K50',
        since: since.toISOString()
      },
      helper: 'running',
      paused: false,
      paired: true,
      version: '0.1.0',
      // Demo only: what the Hub would compute for the phone to reach it.
      host: '192.168.1.100',
      historyCount: 12,
      sessionCount: 12
    };
  }

  /** The demo "database" — a fresh copy per call so mutations do not leak. */
  function create(now) {
    var ref = now instanceof Date ? now : new Date();
    var items = makeHistory(ref);
    return {
      state: makeState(ref),
      items: items,
      pairings: [
        {
          deviceName: 'Redmi K50',
          deviceModel: 'M2012K11AC',
          pairedAt: new Date(ref.getTime() - 1000 * 60 * 60 * 26).toISOString(),
          lastSeenAt: new Date(ref.getTime() - 1000 * 45).toISOString(),
          current: true
        }
      ]
    };
  }

  root.LinkOK = root.LinkOK || {};
  root.LinkOK.demo = { create: create, makeThumb: makeThumb };
})(typeof globalThis !== 'undefined' ? globalThis : this);
