'use strict';

/**
 * Time formatting shared by the Hub.
 *
 * PROTOCOL.md §13: timestamps are ISO 8601 *with offset*
 * (`2026-11-25T16:46:51.132+08:00`); internal computation is UTC; ids must
 * never contain a colon because they end up in file paths and URLs.
 */

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Timezone offset of `date` in the local zone, as `+08:00` / `-05:30`.
 * Positive means east of UTC, matching ISO 8601.
 * @param {Date} date
 * @returns {string}
 */
function offsetString(date) {
  const minutesEast = -date.getTimezoneOffset();
  const sign = minutesEast >= 0 ? '+' : '-';
  const abs = Math.abs(minutesEast);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * `2026-11-25T16:46:51.132+08:00` in the machine's local zone.
 * @param {Date} date
 * @returns {string}
 */
function isoWithOffset(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `.${String(date.getMilliseconds()).padStart(3, '0')}${offsetString(date)}`
  );
}

/**
 * Compact UTC form of an instant, used as the HistoryItem id prefix:
 * `2026-11-25T08:46:51.132Z` -> `20261125T084651132` (PROTOCOL.md §4).
 * @param {Date} date
 * @returns {string}
 */
function compactUtcId(date) {
  return date.toISOString().replace(/[-:.]/g, '').replace(/Z$/, '');
}

/**
 * Local calendar day folder: `2026-11-25`.
 * @param {Date} date
 * @returns {string}
 */
function localDateFolder(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * Local calendar day key used for log file names (`hub-2026-11-25.log`).
 * @param {Date} date
 * @returns {string}
 */
function localDayKey(date) {
  return localDateFolder(date);
}

/**
 * Coerce whatever the wire gave us into a Date, or throw a descriptive error.
 * Accepts Date instances and ISO-8601 strings.
 * @param {unknown} value
 * @param {string} what label used in the error message
 * @returns {Date}
 */
function toDate(value, what) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`${what} is an invalid Date`);
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value);
  }
  throw new Error(`${what} is not a valid timestamp: ${String(value)}`);
}

module.exports = {
  isoWithOffset,
  compactUtcId,
  localDateFolder,
  localDayKey,
  offsetString,
  toDate,
};
