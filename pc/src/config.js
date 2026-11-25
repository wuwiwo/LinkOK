'use strict';

/**
 * The Config object (PROTOCOL.md §7).
 *
 * One instance per Hub, persisted as `%LOCALAPPDATA%\LinkOK\config.json` with
 * an atomic write. Validation is strict for `retentionDays` (only 7/15/30/0)
 * because Retention is a destructive feature and a typo must not silently turn
 * into "never delete" or "delete everything".
 */

const { atomicWriteJsonSync, readJsonFileSync, quarantineFileSync } = require('./fs-atomic');

/** Retention choices in days; 0 means Never (PROTOCOL.md §7). */
const RETENTION_CHOICES = Object.freeze([0, 7, 15, 30]);

/** @typedef {import('./logger').Logger} Logger */

/**
 * @typedef {object} NotificationConfig
 * @property {boolean} enabled
 * @property {boolean} captureDelivered
 * @property {boolean} clipboardSynced
 * @property {boolean} errors
 */

/**
 * @typedef {object} Config
 * @property {number} port
 * @property {number} retentionDays
 * @property {NotificationConfig} notifications
 * @property {boolean} autostart
 * @property {string} screenshotDir
 */

/** @type {Config} */
const DEFAULT_CONFIG = Object.freeze({
  port: 8787,
  retentionDays: 30,
  notifications: Object.freeze({
    enabled: true,
    captureDelivered: true,
    clipboardSynced: false,
    errors: true,
  }),
  autostart: true,
  screenshotDir: '',
});

/** @returns {Config} a deep copy of the defaults */
function defaultConfig() {
  return {
    port: DEFAULT_CONFIG.port,
    retentionDays: DEFAULT_CONFIG.retentionDays,
    notifications: { ...DEFAULT_CONFIG.notifications },
    autostart: DEFAULT_CONFIG.autostart,
    screenshotDir: DEFAULT_CONFIG.screenshotDir,
  };
}

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is an allowed Retention choice
 */
function isRetentionChoice(value) {
  return typeof value === 'number' && RETENTION_CHOICES.includes(value);
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isPortNumber(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Validate + normalise an untrusted Config fragment.
 *
 * `strict` is used for PATCH /api/config: unknown keys and invalid values are
 * rejected with a machine-readable error instead of being silently dropped, so
 * the settings page can never show a value that the Hub did not actually take.
 *
 * @param {unknown} input
 * @param {Config} base the currently effective config
 * @returns {{ok: true, config: Config} | {ok: false, error: string, message: string}}
 */
function mergeConfig(input, base) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'invalid_config', message: '配置必须是一个对象' };
  }
  const source = /** @type {Record<string, unknown>} */ (input);
  const next = {
    port: base.port,
    retentionDays: base.retentionDays,
    notifications: { ...base.notifications },
    autostart: base.autostart,
    screenshotDir: base.screenshotDir,
  };

  const known = new Set(['port', 'retentionDays', 'notifications', 'autostart', 'screenshotDir']);
  for (const key of Object.keys(source)) {
    if (!known.has(key)) {
      return { ok: false, error: 'unknown_field', message: `未知的配置项：${key}` };
    }
  }

  if ('port' in source) {
    if (!isPortNumber(source.port)) {
      return { ok: false, error: 'invalid_port', message: '端口必须是 1–65535 之间的整数' };
    }
    next.port = source.port;
  }

  if ('retentionDays' in source) {
    if (!isRetentionChoice(source.retentionDays)) {
      return {
        ok: false,
        error: 'invalid_retention_days',
        message: '保留期只能是 7、15、30 或 0（永不）',
      };
    }
    next.retentionDays = source.retentionDays;
  }

  if ('notifications' in source) {
    const value = source.notifications;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'invalid_notifications', message: '通知配置必须是一个对象' };
    }
    const notif = /** @type {Record<string, unknown>} */ (value);
    const allowed = new Set(['enabled', 'captureDelivered', 'clipboardSynced', 'errors']);
    for (const key of Object.keys(notif)) {
      if (!allowed.has(key)) {
        return { ok: false, error: 'unknown_field', message: `未知的通知配置项：${key}` };
      }
      if (typeof notif[key] !== 'boolean') {
        return { ok: false, error: 'invalid_notifications', message: `通知开关 ${key} 必须是布尔值` };
      }
      // @ts-expect-error key is validated against `allowed` above
      next.notifications[key] = notif[key];
    }
  }

  if ('autostart' in source) {
    if (typeof source.autostart !== 'boolean') {
      return { ok: false, error: 'invalid_autostart', message: '开机自启必须是布尔值' };
    }
    next.autostart = source.autostart;
  }

  if ('screenshotDir' in source) {
    if (typeof source.screenshotDir !== 'string') {
      return { ok: false, error: 'invalid_screenshot_dir', message: '截图目录必须是字符串' };
    }
    next.screenshotDir = source.screenshotDir.trim();
  }

  return { ok: true, config: next };
}

/**
 * Load a Config from disk, repairing anything invalid.
 *
 * A corrupt file is quarantined (renamed, never deleted) and the defaults are
 * used, so a mangled config can never brick the Hub.
 *
 * @param {string} file
 * @param {Logger} logger
 * @returns {{config: Config, created: boolean, repaired: string[]}}
 */
function loadConfig(file, logger) {
  const repaired = [];
  let raw;
  try {
    const read = readJsonFileSync(file, null);
    if (!read.existed) {
      const config = defaultConfig();
      saveConfig(file, config);
      logger.info(`created default config at ${file}`);
      return { config, created: true, repaired };
    }
    raw = read.value;
  } catch (err) {
    const backup = quarantineFileSync(file);
    logger.error(`config.json is unreadable; falling back to defaults`, {
      error: /** @type {Error} */ (err).message,
      quarantined: backup,
    });
    const config = defaultConfig();
    saveConfig(file, config);
    return { config, created: true, repaired: ['unreadable'] };
  }

  const base = defaultConfig();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    const backup = quarantineFileSync(file);
    logger.error(`config.json is not an object; falling back to defaults`, { quarantined: backup });
    saveConfig(file, base);
    return { config: base, created: true, repaired: ['not-an-object'] };
  }

  const source = /** @type {Record<string, unknown>} */ (raw);

  if ('port' in source) {
    if (isPortNumber(source.port)) base.port = source.port;
    else repaired.push('port');
  }
  if ('retentionDays' in source) {
    if (isRetentionChoice(source.retentionDays)) base.retentionDays = source.retentionDays;
    else repaired.push('retentionDays');
  }
  if ('notifications' in source) {
    const notif = source.notifications;
    if (notif && typeof notif === 'object' && !Array.isArray(notif)) {
      for (const key of Object.keys(base.notifications)) {
        const value = /** @type {Record<string, unknown>} */ (notif)[key];
        if (typeof value === 'boolean') {
          // @ts-expect-error key comes from base.notifications
          base.notifications[key] = value;
        } else if (value !== undefined) {
          repaired.push(`notifications.${key}`);
        }
      }
    } else {
      repaired.push('notifications');
    }
  }
  if ('autostart' in source) {
    if (typeof source.autostart === 'boolean') base.autostart = source.autostart;
    else repaired.push('autostart');
  }
  if ('screenshotDir' in source) {
    if (typeof source.screenshotDir === 'string') base.screenshotDir = source.screenshotDir.trim();
    else repaired.push('screenshotDir');
  }
  for (const key of Object.keys(source)) {
    if (!['port', 'retentionDays', 'notifications', 'autostart', 'screenshotDir'].includes(key)) {
      repaired.push(`unknown:${key}`);
    }
  }

  if (repaired.length > 0) {
    logger.warn(`config.json had invalid values; repaired`, { repaired });
    saveConfig(file, base);
  }
  return { config: base, created: false, repaired };
}

/**
 * @param {string} file
 * @param {Config} config
 */
function saveConfig(file, config) {
  atomicWriteJsonSync(file, config);
}

/**
 * In-memory Config owner used by the HTTP layer.
 */
class ConfigStore {
  /**
   * @param {object} options
   * @param {string} options.file
   * @param {Logger} options.logger
   */
  constructor({ file, logger }) {
    this.file = file;
    this.logger = logger;
    /** @type {Config} */
    this.current = defaultConfig();
  }

  /** @returns {Config} the live config (do not mutate) */
  get() {
    return this.current;
  }

  /** @returns {Config} a deep copy safe to serialise */
  snapshot() {
    return {
      port: this.current.port,
      retentionDays: this.current.retentionDays,
      notifications: { ...this.current.notifications },
      autostart: this.current.autostart,
      screenshotDir: this.current.screenshotDir,
    };
  }

  load() {
    const { config } = loadConfig(this.file, this.logger);
    this.current = config;
    return config;
  }

  /**
   * Apply a partial update from PATCH /api/config.
   * @param {unknown} patch
   * @returns {{ok: true, config: Config} | {ok: false, error: string, message: string}}
   */
  patch(patch) {
    const merged = mergeConfig(patch, this.current);
    if (!merged.ok) return merged;
    const previousPort = this.current.port;
    saveConfig(this.file, merged.config);
    this.current = merged.config;
    this.logger.info('config updated', { patch, port: merged.config.port });
    if (merged.config.port !== previousPort) {
      this.logger.warn(
        `port changed to ${merged.config.port}; it takes effect the next time the Hub starts`,
      );
    }
    return merged;
  }
}

module.exports = {
  DEFAULT_CONFIG,
  RETENTION_CHOICES,
  defaultConfig,
  mergeConfig,
  loadConfig,
  saveConfig,
  ConfigStore,
  isRetentionChoice,
  isPortNumber,
};
