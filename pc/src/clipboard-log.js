'use strict';

/**
 * 剪贴板同步历史。
 *
 * 为什么要存：Clipboard Sync 原本是**完全透明的** —— 文本写进剪贴板就没了，
 * 用户在两端界面上都看不到"刚刚同步了什么"。出问题时无从判断是没同步、
 * 同步错了、还是被 Echo 抑制吃掉了。
 *
 * 这不是"剪贴板管理器"（SPEC §2.2 明确不做历史），只保留最近若干条用于观察同步活动，
 * 重启即清空，不落盘。
 */

/** 最多保留多少条。够看清最近的活动即可，不做无限增长。 */
const MAX_ENTRIES = 50;
/** 单条预览最多显示多少字符 —— 存全文没有意义，还会把内存和界面撑爆。 */
const PREVIEW_CHARS = 500;

/**
 * @typedef {object} ClipboardEntry
 * @property {string} id
 * @property {'inbound'|'outbound'} direction inbound = 手机→电脑，outbound = 电脑→手机
 * @property {string} preview 截断后的文本，用于界面展示
 * @property {number} chars 原始字符数（不含截断）
 * @property {number} bytes UTF-8 字节数
 * @property {string} at ISO-8601 带偏移
 * @property {boolean} truncated preview 是否被截断
 */

class ClipboardLog {
  /**
   * @param {object} options
   * @param {() => Date} [options.now]
   * @param {import('./logger').Logger} [options.logger]
   */
  constructor({ now = () => new Date(), logger = null } = {}) {
    this.now = now;
    this.logger = logger;
    /** @type {ClipboardEntry[]} 最新的在前 */
    this.entries = [];
    this.counter = 0;
  }

  /**
   * 记一条。文本本身不保留全文，只留预览 —— 剪贴板里可能是密码，
   * 没有理由在内存里长期驻留完整内容。
   *
   * @param {'inbound'|'outbound'} direction
   * @param {string} text
   * @returns {ClipboardEntry}
   */
  record(direction, text) {
    const raw = typeof text === 'string' ? text : '';
    const bytes = Buffer.byteLength(raw, 'utf8');
    const trimmed = raw.length > PREVIEW_CHARS;
    const preview = trimmed ? raw.slice(0, PREVIEW_CHARS) : raw;

    this.counter += 1;
    /** @type {ClipboardEntry} */
    const entry = {
      id: `cb-${this.counter}`,
      direction,
      preview,
      chars: raw.length,
      bytes,
      at: this.now().toISOString(),
      truncated: trimmed,
    };

    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.length = MAX_ENTRIES;
    }
    return entry;
  }

  /** @returns {ClipboardEntry[]} 最新在前 */
  list(limit = MAX_ENTRIES) {
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_ENTRIES) : MAX_ENTRIES;
    return this.entries.slice(0, n);
  }

  clear() {
    this.entries.length = 0;
  }
}

module.exports = { ClipboardLog, MAX_ENTRIES, PREVIEW_CHARS };
