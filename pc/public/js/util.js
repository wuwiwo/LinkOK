/* LinkOK — formatting and small pure helpers.
 *
 * All user-facing dates come from `arrivedAt`, which PROTOCOL §13 defines as an
 * ISO-8601 instant with an offset. The page displays them in the PC's local
 * zone, because the PC is the only device the page ever runs on.
 *
 * Nothing here touches the DOM. It is written so the node verifier can import
 * these functions directly and assert on the exact strings the UI will show.
 */
(function (root) {
  'use strict';

  /** Two-digit zero pad. */
  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Parse an ISO instant; returns null rather than an Invalid Date. */
  function parseInstant(value) {
    if (!value) return null;
    var d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }

  /** "16:46" — the time of day, local zone. */
  function formatTime(iso) {
    var d = parseInstant(iso);
    if (!d) return '时间未知';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  /** "16:46:51" — used where seconds matter (pairing countdown end). */
  function formatTimeLong(iso) {
    var d = parseInstant(iso);
    if (!d) return '时间未知';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /** Local calendar day key, "2026-11-25". Used for grouping, not for display. */
  function dayKey(iso, now) {
    var d = parseInstant(iso);
    if (!d) return 'unknown';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /** Day key of "today" in the same format, so grouping can compare keys. */
  function todayKey(now) {
    var d = now instanceof Date ? now : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function addDays(date, delta) {
    var d = new Date(date.getTime());
    d.setDate(d.getDate() + delta);
    return d;
  }

  /**
   * Human label for a day key: 今天 / 昨天 / 11月23日 (same year) / 2025年11月23日.
   * `now` is injectable so the tests are not dependent on the wall clock.
   */
  function formatDayLabel(key, now) {
    var today = now instanceof Date ? now : new Date();
    var todayK = todayKey(today);
    var yesterdayK = todayKey(addDays(today, -1));
    if (key === todayK) return '今天';
    if (key === yesterdayK) return '昨天';

    var parts = key.split('-');
    if (parts.length !== 3) return '日期未知';
    var year = Number(parts[0]);
    var month = Number(parts[1]);
    var day = Number(parts[2]);
    if (!month || !day) return '日期未知';
    if (year === today.getFullYear()) return month + '月' + day + '日';
    return year + '年' + month + '月' + day + '日';
  }

  /** "刚刚" / "3 分钟前" / "2 小时前", falling back to an absolute date after a day. */
  function formatRelative(iso, now) {
    var d = parseInstant(iso);
    if (!d) return '时间未知';
    var ref = now instanceof Date ? now : new Date();
    var deltaMs = ref.getTime() - d.getTime();
    if (deltaMs < 0) return formatTime(iso);
    var minutes = Math.floor(deltaMs / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return minutes + ' 分钟前';
    var hours = Math.floor(minutes / 60);
    if (hours < 24 && dayKey(iso) === todayKey(ref)) return hours + ' 小时前';
    if (dayKey(iso) === todayKey(addDays(ref, -1))) return '昨天 ' + formatTime(iso);
    return formatDayLabel(dayKey(iso), ref) + ' ' + formatTime(iso);
  }

  /** Bytes as a short human size with a non-breaking space. */
  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '大小未知';
    if (bytes < 1024) return bytes + '\u00a0B';
    var kb = bytes / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + '\u00a0KB';
    var mb = kb / 1024;
    return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + '\u00a0MB';
  }

  /** "1080 × 2400" — a multiplication sign, not the letter x. */
  function formatDimensions(width, height) {
    if (!width || !height) return '';
    return width + '\u00a0×\u00a0' + height;
  }

  /** Source label for a HistoryItem, per PROTOCOL §4. */
  var SOURCE_LABEL = {
    phone: '来自手机',
    'pc-clipboard': '来自电脑剪贴板',
    'pc-folder': '来自截图文件夹'
  };

  var SOURCE_SHORT = {
    phone: '手机',
    'pc-clipboard': '电脑剪贴板',
    'pc-folder': '截图文件夹'
  };

  function sourceLabel(source) {
    return SOURCE_LABEL[source] || '来源未知';
  }

  function sourceShort(source) {
    return SOURCE_SHORT[source] || '未知来源';
  }

  /**
   * Pairing payload, PROTOCOL §6.1:
   *   linkok://pair?host=<ip>&port=<port>&code=<code>&fp=<fingerprint>
   * The Hub returns this verbatim as `qrPayload`; this builder is only a
   * fallback for when the Hub omits it.
   */
  function buildPairPayload(opts) {
    var host = opts.host || (root.location ? root.location.hostname : '127.0.0.1');
    var port = opts.port || (root.location ? root.location.port : '') || '8787';
    var parts = [
      'host=' + encodeURIComponent(host),
      'port=' + encodeURIComponent(port),
      'code=' + encodeURIComponent(opts.code || ''),
      'fp=' + encodeURIComponent(opts.fp || '')
    ];
    return 'linkok://pair?' + parts.join('&');
  }

  /**
   * The address the phone should use. When the page was opened on the PC's own
   * loopback address that is useless to the phone, so prefer whatever the Hub
   * reports; if nothing better is available, still show it but flag it.
   */
  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }

  /** Seconds remaining until an ISO instant, floored at 0. */
  function secondsUntil(iso, now) {
    var d = parseInstant(iso);
    if (!d) return 0;
    var ref = now instanceof Date ? now : new Date();
    return Math.max(0, Math.floor((d.getTime() - ref.getTime()) / 1000));
  }

  /** "1:59" style countdown. */
  function formatCountdown(seconds) {
    var s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }

  /** Clamp a number into a range. */
  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  /** Deep-ish merge for the config object: one level of nested objects. */
  function mergeConfig(base, patch) {
    var out = {};
    var key;
    for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
    for (key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      var value = patch[key];
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])
      ) {
        var nested = {};
        for (var n in out[key]) if (Object.prototype.hasOwnProperty.call(out[key], n)) nested[n] = out[key][n];
        for (var m in value) if (Object.prototype.hasOwnProperty.call(value, m)) nested[m] = value[m];
        out[key] = nested;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  /** Deep equality for the small JSON-ish values this page compares. */
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var i = 0; i < ka.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(b, ka[i])) return false;
      if (!deepEqual(a[ka[i]], b[ka[i]])) return false;
    }
    return true;
  }

  /** Group HistoryItems by local day, newest day first, newest item first. */
  function groupByDay(items, now) {
    var byKey = {};
    var order = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = dayKey(item.arrivedAt, now);
      if (!byKey[key]) {
        byKey[key] = [];
        order.push(key);
      }
      byKey[key].push(item);
    }
    order.sort(function (a, b) {
      return a < b ? 1 : a > b ? -1 : 0;
    });
    return order.map(function (key) {
      var group = byKey[key].slice().sort(function (a, b) {
        var ta = parseInstant(a.arrivedAt);
        var tb = parseInstant(b.arrivedAt);
        return (tb ? tb.getTime() : 0) - (ta ? ta.getTime() : 0);
      });
      return {
        key: key,
        label: formatDayLabel(key, now),
        items: group
      };
    });
  }

  /** Escape for safe interpolation into an HTML string. */
  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Reject anything that is not a same-origin-relative path. The Hub serves
   * `/api/history/:id/raw`, and ids come from the network, so a hostile or
   * corrupted id must not become a `javascript:` or absolute URL.
   */
  function historyRawPath(id) {
    var safe = String(id == null ? '' : id).replace(/[^A-Za-z0-9_-]/g, '');
    if (!safe) return null;
    return '/api/history/' + safe + '/raw';
  }

  root.LinkOK = root.LinkOK || {};
  root.LinkOK.util = {
    pad2: pad2,
    parseInstant: parseInstant,
    formatTime: formatTime,
    formatTimeLong: formatTimeLong,
    dayKey: dayKey,
    todayKey: todayKey,
    addDays: addDays,
    formatDayLabel: formatDayLabel,
    formatRelative: formatRelative,
    formatBytes: formatBytes,
    formatDimensions: formatDimensions,
    sourceLabel: sourceLabel,
    sourceShort: sourceShort,
    buildPairPayload: buildPairPayload,
    isLoopbackHost: isLoopbackHost,
    secondsUntil: secondsUntil,
    formatCountdown: formatCountdown,
    clamp: clamp,
    mergeConfig: mergeConfig,
    deepEqual: deepEqual,
    groupByDay: groupByDay,
    escapeHtml: escapeHtml,
    historyRawPath: historyRawPath
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
