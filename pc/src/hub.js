'use strict';

/**
 * The Hub: wires config, pairing, History, the helper, the Link and HTTP
 * together and owns the process-wide state that is not a file.
 *
 * Everything time-based in here exists because SPEC.md demands it:
 *  - a Phone that has been offline for more than 5 minutes raises exactly one
 *    "手机已离线" notification, not one per second (D10);
 *  - the Tray mirrors Link state so the user can see connectivity at a glance;
 *  - the QR window is re-shown from the Tray without touching the HTTP layer.
 */

const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { MAX_QUEUED_CAPTURES } = require('./link');

const { ConfigStore } = require('./config');
const { PairingService } = require('./pairing');
const { HistoryStore } = require('./history-store');
const { HelperSupervisor } = require('./helper-supervisor');
const { EchoGuard } = require('./echo-guard');
const { ClipboardLog } = require('./clipboard-log');
const { Link } = require('./link');
const { HttpServer } = require('./http-server');
const { primaryLanAddress } = require('./net');
const { resolveScreenshotDir } = require('./screenshot-dir');
const { defaultHelperPath, defaultStaticDir, layoutFor } = require('./paths');
const { sha256Hex, truncateUtf8 } = require('./crypto-util');
const { isoWithOffset } = require('./time');
const { readPngSize, tryReadPngSize, isWithinCaptureLimit } = require('./media');

/** How long the Phone may be silent before we tell the user (SPEC D10). */
const OFFLINE_NOTIFY_MS = 5 * 60 * 1000;

class Hub extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {import('./logger').Logger} options.logger
   * @param {string} options.version
   * @param {string} [options.helperPath]
   * @param {string} [options.staticDir]
   * @param {boolean} [options.startHelper]
   * @param {number} [options.portOverride]
   * @param {() => Date} [options.now]
   */
  constructor({
    dataDir,
    logger,
    version,
    helperPath = defaultHelperPath(),
    staticDir = defaultStaticDir(),
    startHelper = true,
    portOverride = null,
    now = () => new Date(),
  }) {
    super();
    this.logger = logger;
    this.version = version;
    this.now = now;
    this.layout = layoutFor(dataDir);
    this.portOverride = portOverride;
    this.startHelper = startHelper;

    this.configStore = new ConfigStore({ file: this.layout.configFile, logger });
    this.pairing = new PairingService({ deviceFile: this.layout.deviceFile, logger, now });
    this.history = new HistoryStore({ dir: this.layout.historyDir, logger, now });
    this.echoGuard = new EchoGuard({ now: () => this.now().getTime() });

    // 观察用，不落盘：让设置页能看到"刚刚同步了什么"。
    // 剪贴板同步原本是完全透明的，出了问题无从判断。
    this.clipboardLog = new ClipboardLog({ now: () => this.now(), logger });

    this.helper = new HelperSupervisor({
      helperPath,
      logger,
      enabled: startHelper,
      isPaused: () => this.paused,
      tempDir: this.layout.tmpDir,
    });

    this.http = new HttpServer({
      configStore: this.configStore,
      pairing: this.pairing,
      history: this.history,
      helper: this.helper,
      logger,
      staticDir,
      getLink: () => this.link,
      isPaused: () => this.paused,
      setPaused: (paused) => this.setPaused(paused),
      version,
      lanAddress: () => this.lanAddress,
      revealInExplorer: (target) => this.revealInExplorer(target),
      clipboardLog: this.clipboardLog,
      qrcode: safeRequireQrcode(logger),
    });

    /** @type {Link|null} */
    this.link = null;
    /**
     * PC Captures that the Phone has not acknowledged yet, oldest first. Kept on
     * the Hub (not on a Link) so they survive a disconnect and are replayed on
     * the next connection. Bounded by MAX_QUEUED_CAPTURES.
     *
     * @type {Array<{png: Buffer, arrivedAt: Date, sha256: string, width: number|null, height: number|null}>}
     */
    this.pendingOutbound = [];
    this.paused = false;
    /** @type {NodeJS.Timeout|null} */
    this.offlineTimer = null;
    this.offlineNotified = false;
    /** @type {NodeJS.Timeout|null} */
    this.retentionTimer = null;

    this.lanAddress = primaryLanAddress();
    /** @type {string} */
    this.screenshotDir = '';

    this._wireEvents();
  }

  _wireEvents() {
    this.http.on('connection', (connection) => this._adoptConnection(connection));
    this.http.on('config', (config) => {
      this._onConfigChanged(config);
    });
    this.http.on('paused', (paused) => {
      this.logger.info(`sync ${paused ? 'paused' : 'resumed'} from the settings page`);
    });
    this.http.on('pairing-code', ({ code }) => {
      this.logger.info(`pairing code ${code} is live for 120 s`);
    });

    this.helper.on('event', (message) => this._onHelperEvent(message));
    this.helper.on('error', (err) => {
      this.logger.error('helper supervisor error', { error: /** @type {Error} */ (err).message });
    });
    this.helper.on('ready', () => {
      this._updateTray();
      // A helper that just came back needs to know whether sync is paused.
      this.helper.setPaused(this.paused);
      // The banner runs before the helper finishes booting, so its showQr call is
      // dropped when isRunning is still false. Re-offer the pairing QR now that the
      // helper can actually draw a window, otherwise a first-run user sees nothing.
      this._showPendingPairingQr();
    });
    this.helper.on('gave-up', () => {
      this._notify('errors', '原生助手已停止', '连续 5 次启动失败，剪贴板与托盘功能不可用。请检查 pc\\helper\\linkok-helper.exe。');
    });
    this.helper.on('degraded', ({ code, message }) => {
      this.logger.warn(`helper is degraded: ${code} ${message}`);
      this._notify('errors', '原生助手功能受限', `${message || code}`);
    });
    this.helper.on('failure', ({ reason }) => {
      if (reason.startsWith('spawn') || reason.startsWith('exit')) {
        this.logger.debug(`helper failure recorded (${reason})`);
      }
    });
  }

  /**
   * Boot: load persisted state, resolve paths, start the helper and the sweeper.
   * @returns {Promise<void>}
   */
  async init() {
    this.configStore.load();
    this.pairing.load();
    this.history.load();

    this.screenshotDir = this.configStore.get().screenshotDir;
    if (this.screenshotDir === '') {
      // PROTOCOL §7: resolve the redirected screenshot folder from the registry.
      // The helper also resolves it itself; this copy exists so the settings page
      // can display the value.
      this.screenshotDir = resolveScreenshotDir({ logger: this.logger });
      if (this.screenshotDir !== '') {
        this.logger.info(`screenshot folder resolved: ${this.screenshotDir}`);
        this.configStore.patch({ screenshotDir: this.screenshotDir });
      } else {
        this.logger.debug('screenshot folder could not be resolved; the helper will resolve it');
      }
    }

    // PROTOCOL §10: sweep on startup, then hourly. HistoryStore owns the timer.
    this.history.startSweeper(() => this.configStore.get().retentionDays);

    if (this.startHelper) this.helper.start();
    this._updateTray();
  }

  /**
   * @param {number} [port]
   * @returns {Promise<{port: number, host: string}>}
   */
  async listen(port = this.portOverride ?? this.configStore.get().port) {
    const result = await this.http.listen(port, '0.0.0.0');
    this.logger.info(`Hub listening on http://0.0.0.0:${result.port} (LAN ${this.lanAddress})`);
    return result;
  }

  /** @returns {string} the URL a human should open on this PC */
  get settingsUrl() {
    const port = this.http.server && this.http.server.address() ? this.http.server.address().port : this.configStore.get().port;
    return `http://127.0.0.1:${port}`;
  }

  /**
   * Adopt a freshly authenticated WebSocket as *the* Link. PROTOCOL §12 allows
   * exactly one, so the previous one is closed with 1000 (normal).
   *
   * Anything captured while the Phone was away is replayed here from
   * `pendingOutbound`, which is why a PC Capture taken with the Phone offline
   * still arrives after reconnect instead of being forgotten.
   *
   * @param {import('./ws').WebSocketConnection} connection
   */
  _adoptConnection(connection) {
    const previous = this.link;
    if (previous && !previous.closed) {
      this.logger.info('a new Link arrived; closing the previous one (single connection rule)');
      previous.close('replaced');
      this.link = null;
    }
    this._attachLink(connection);
  }

  /**
   * @param {import('./ws').WebSocketConnection} connection
   */
  _attachLink(connection) {
    const link = new Link({
      connection,
      history: this.history,
      echoGuard: this.echoGuard,
      helper: this.helper,
      logger: this.logger,
      clipboardLog: this.clipboardLog,
    });
    this.link = link;
    this.offlineNotified = false;

    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }

    link.on('close', () => {
      if (this.link !== link) return;
      // 把 Link 上还没发出去的图收回 Hub 的待发队列。
      //
      // 不这样做的话，Link 对象被丢弃时它内部的 outboundQueue 一并消失：
      // 连接断开那一刻正在排队（或正在等 ACK）的截图既没有 delivered，
      // 也没进 pendingOutbound，重连后永远不会补发。
      // 用户看到的就是"电脑截图了，手机没反应"。
      const leftovers = link.drainQueue();
      if (leftovers && leftovers.length > 0) {
        const recovered = leftovers.length;
        for (const capture of leftovers) {
          this._rememberPendingOutbound(
            capture.png,
            capture.arrivedAt,
            sha256Hex(capture.png),
          );
        }
        this.logger.info(`recovered ${recovered} undelivered capture(s) for replay on reconnect`);
      }
      this.link = null;
      this.logger.info('Link is down');
      this._updateTray();
      this._armOfflineNotification();
    });
    link.on('capture', ({ item }) => {
      this.logger.info(`phone capture stored: ${item.id}`);
      this._updateTray();
    });
    link.on('duplicate', ({ id }) => {
      this.logger.info(`duplicate capture ${id} dropped`);
    });
    link.on('delivered', ({ sha256, id }) => {
      // The Phone confirmed receipt, so this Capture no longer needs replaying.
      this._forgetPendingOutbound(sha256);
      // 必须记录成功。
      //
      // 之前这里什么都不打，导致日志停在 `sending capture` 就再无下文 ——
      // 看起来像卡住或丢图，实际是投递成功了。排查"手机没收到"时，
      // 无法区分「发了没确认」和「发了且确认了」，是最误导的一处。
      this.logger.info(`capture ${id || ''} delivered to the Phone${id ? '' : ` (${sha256.slice(0, 12)}…)`}`);
    });
    link.on('notify', (payload) => {
      this._notify(payload.category, payload.title, payload.body, payload.thumbFile);
    });
    link.on('clipboard', (payload) => {
      if (!this.configStore.get().notifications.clipboardSynced) return;
      const preview = payload.text.length > 40 ? `${payload.text.slice(0, 40)}…` : payload.text;
      this._notify('clipboardSynced', payload.direction === 'inbound' ? '已从手机同步剪贴板' : '已把剪贴板发到手机', preview);
    });

    // Replay whatever piled up while the Phone was away, oldest first.
    const pending = this.pendingOutbound.slice();
    if (pending.length > 0) {
      this.logger.info(`replaying ${pending.length} capture(s) captured while the Phone was away`);
    }
    for (const capture of pending) {
      link.enqueueCapture(capture.png, capture.arrivedAt);
    }

    this._updateTray();
    this.emit('link', link);
  }

  _armOfflineNotification() {
    if (this.offlineTimer) clearTimeout(this.offlineTimer);
    if (this.offlineNotified) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      if (this.link && !this.link.closed) return;
      this.offlineNotified = true;
      this._notify('errors', '手机已离线', `超过 ${OFFLINE_NOTIFY_MS / 60000} 分钟没有连接。请确认两端在同一 Wi-Fi。`);
    }, OFFLINE_NOTIFY_MS);
    if (typeof this.offlineTimer.unref === 'function') this.offlineTimer.unref();
  }

  /**
   * @param {import('./config').Config} config
   */
  _onConfigChanged(config) {
    this.logger.info('config change applied', {
      retentionDays: config.retentionDays,
      notifications: config.notifications,
    });
    if (config.screenshotDir !== this.screenshotDir) {
      this.screenshotDir = config.screenshotDir;
      // The helper resolves the folder itself, but an explicit override must win.
      this.helper.send({ cmd: 'configure', screenshotDir: this.screenshotDir });    }
    this._updateTray();
  }

  /**
   * @param {Record<string, any>} message
   */
  _onHelperEvent(message) {
    switch (message.evt) {
      case 'clipboard-text': {
        this._onHelperClipboardText(message);
        return;
      }
      case 'clipboard-image': {
        void this._onHelperClipboardImage(message);
        return;
      }
      case 'file-captured': {
        void this._onHelperFileCaptured(message);
        return;
      }
      case 'tray-click': {
        void this._onTrayClick(message);
        return;
      }
      default:
        this.logger.debug(`unhandled helper event: ${message.evt}`);
    }
  }

  /**
   * PC clipboard changed to some text: that is a PC Capture of the clipboard.
   * @param {Record<string, any>} message
   */
  _onHelperClipboardText(message) {
    if (typeof message.text !== 'string') {
      this.logger.warn('helper clipboard-text event without text; ignored');
      return;
    }
    if (this.paused) {
      this.logger.debug('sync is paused; PC clipboard text not sent');
      return;
    }
    const link = this.link;
    if (!link || link.closed) {
      this.logger.debug('Link is down; PC clipboard text cannot be sent now');
      return;
    }
    const result = link.sendClipboard(message.text);
    if (!result.sent) {
      this.logger.debug(`PC clipboard text not sent: ${result.reason}`);
    }
  }

  /**
   * PC clipboard received an image (PrtSc, Win+Shift+S, "copy image").
   * The helper already wrote it to a PNG file.
   * @param {Record<string, any>} message
   */
  async _onHelperClipboardImage(message) {
    await this._ingestHelperFile(message, 'pc-clipboard');
  }

  /**
   * A file appeared in the watched screenshot folder.
   * @param {Record<string, any>} message
   */
  async _onHelperFileCaptured(message) {
    await this._ingestHelperFile(message, 'pc-folder');
  }

  /**
   * @param {Record<string, any>} message
   * @param {'pc-clipboard'|'pc-folder'} source
   */
  async _ingestHelperFile(message, source) {
    const file = typeof message.file === 'string' ? message.file : '';
    if (file === '') {
      this.logger.warn(`helper sent a ${source} event without a file path; ignored`);
      return;
    }
    if (this.paused) {
      this.logger.debug(`sync is paused; ${source} capture not ingested`);
      return;
    }
    const fs = require('node:fs');
    let png;
    try {
      png = await fs.promises.readFile(file);
    } catch (err) {
      this.logger.error(`could not read the ${source} capture at ${file}`, {
        error: /** @type {Error} */ (err).message,
      });
      return;
    }
    if (!isWithinCaptureLimit(png.length)) {
      this.logger.error(`refusing a ${source} capture of ${png.length} bytes (limit 20MB): ${file}`);
      this._notify('errors', '图片过大', '超过 20MB 的图片不会被 LinkOK 处理。');
      return;
    }
    let size;
    try {
      size = readPngSize(png);
    } catch (err) {
      this.logger.error(`the ${source} capture is not a usable PNG`, {
        file,
        error: /** @type {Error} */ (err).message,
      });
      return;
    }

    const { item, duplicate } = await this.history.addCapture({
      png,
      source,
      arrivedAt: this.now(),
      width: size.width,
      height: size.height,
    });
    if (duplicate) {
      this.logger.info(`duplicate ${source} capture dropped: ${file}`);
      return;
    }

    const link = this.link;
    if (link && !link.closed) {
      if (!link.enqueueCapture(png, this.now())) {
        this._rememberPendingOutbound(png, this.now(), item.sha256);
      }
    } else {
      // No Phone right now: keep it for replay on the next connection, so a PC
      // Capture taken while the Phone is away is not silently lost.
      this._rememberPendingOutbound(png, this.now(), item.sha256);
      this.logger.info(`no Link; ${item.id} stored in History and queued for replay`);
    }
    this.emit('capture', { item, direction: 'outbound' });
  }

  /**
   * @param {Buffer} png
   * @param {Date} arrivedAt
   * @param {string} sha256
   */
  _rememberPendingOutbound(png, arrivedAt, sha256) {
    if (this.pendingOutbound.some((entry) => entry.sha256 === sha256)) return;
    if (this.pendingOutbound.length >= MAX_QUEUED_CAPTURES) {
      // Drop the oldest: the newest captures are the ones the user wants.
      const dropped = this.pendingOutbound.shift();
      this.logger.warn(`pending outbound queue is full; dropping ${dropped ? dropped.sha256.slice(0, 12) : '?'}…`);
    }
    const size = tryReadPngSize(png);
    this.pendingOutbound.push({ png, arrivedAt, sha256, width: size.width, height: size.height });
  }

  /**
   * @param {string} sha256
   */
  _forgetPendingOutbound(sha256) {
    const index = this.pendingOutbound.findIndex((entry) => entry.sha256 === sha256);
    if (index !== -1) this.pendingOutbound.splice(index, 1);
  }

  /**
   * Draw the pending pairing QR as soon as the helper can host a window.
   *
   * On a first run the banner mints the code before the helper has finished
   * booting, so the window request is lost and the user is left with only a
   * console line they may not be looking at. This is the retry.
   */
  _showPendingPairingQr() {
    const pending = this._pendingPairingQr;
    if (!pending) return;
    if (this.pairing.isPaired()) {
      this._pendingPairingQr = null;
      return;
    }
    if (Date.now() > pending.expiresAt) {
      this.logger.info('pending pairing code expired before the helper was ready; not showing it');
      this._pendingPairingQr = null;
      return;
    }
    if (!this.helper.isRunning) return;
    this.logger.info(`showing the pairing QR window (code ${pending.code})`);
    this.helper.showQr(pending.payload);
  }

  /**
   * @param {Record<string, any>} message
   */
  async _onTrayClick(message) {
    const item = String(message.item || '');
    switch (item) {
      case 'pair': {
        const { code, expiresAt } = this.pairing.mintCode();
        const payload = this.pairing.qrPayload(this.lanAddress, this.configStore.get().port, code);
        this.helper.showQr(payload);
        this.logger.info(`pairing code ${code} minted from the Tray (expires ${new Date(expiresAt).toISOString()})`);
        this.emit('pairing-code', { code, expiresAt, qrPayload: payload });
        return;
      }
      case 'settings': {
        this.logger.info(`settings requested from the Tray: ${this.settingsUrl}`);
        this.emit('open-settings', this.settingsUrl);
        return;
      }
      case 'pause': {
        const paused = message.paused === undefined ? !this.paused : Boolean(message.paused);
        await this.setPaused(paused);
        return;
      }
      case 'autostart': {
        // The helper already wrote HKCU\...\Run; only the config needs to agree.
        const enabled = Boolean(message.enabled);
        const result = this.configStore.patch({ autostart: enabled });
        if (!result.ok) {
          this.logger.error('could not persist the autostart choice', { error: result.error });
        }
        return;
      }
      case 'quit': {
        this.logger.info('quit requested from the Tray');
        this.emit('quit-requested');
        return;
      }
      default:
        this.logger.debug(`unhandled tray item: ${item}`);
    }
  }

  /**
   * @param {boolean} paused
   */
  async setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    this.helper.setPaused(paused);
    this._updateTray();
    this.logger.info(`sync ${paused ? 'paused' : 'resumed'}`);
    this.emit('paused', paused);
  }

  _updateTray() {
    const link = this.link;
    if (this.paused) {
      this.helper.setTrayState('paused');
      return;
    }
    if (link && !link.closed) {
      this.helper.setTrayState('connected', link.deviceName || null);
      return;
    }
    this.helper.setTrayState('disconnected');
  }

  /**
   * Route a notification through the config toggles (SPEC §5.7).
   * @param {'captureDelivered'|'clipboardSynced'|'errors'} category
   * @param {string} title
   * @param {string} body
   * @param {string} [thumbFile]
   */
  _notify(category, title, body, thumbFile) {
    const config = this.configStore.get();
    const notifications = config.notifications;
    if (!notifications.enabled) return;
    if (!notifications[category]) {
      this.logger.debug(`notification suppressed by config: ${category}`);
      return;
    }
    if (!this.helper.isRunning) {
      this.logger.info(`notification (helper unavailable): ${title} — ${body}`);
      return;
    }
    this.helper.notify({ title, body, thumbFile });
  }

  /**
   * @param {string} target absolute path
   */
  revealInExplorer(target) {
    const fs = require('node:fs');
    const path = require('node:path');
    if (!fs.existsSync(target)) {
      throw new Error(`path does not exist: ${target}`);
    }
    const stat = fs.statSync(target);
    // `explorer.exe /select,<file>` opens the folder with the file highlighted.
    // Detached and unref'd so a slow Explorer never holds the Hub's event loop.
    const { spawn } = require('node:child_process');
    const args = stat.isDirectory() ? [target] : [`/select,${path.resolve(target)}`];
    const child = spawn('explorer.exe', args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', (err) => {
      this.logger.warn('could not open Explorer', { error: err.message });
    });
    child.unref();
  }

  /**
   * Announce the Hub on stdout in a human-readable way.
   *
   * First run prints a pairing code. This is the only bootstrap path: the Phone
   * has no Token yet, so it cannot call `POST /api/pairing-code`, and the Tray
   * may be unavailable. Printing the code to the console the user just launched
   * closes that chicken-and-egg loop without opening an unauthenticated endpoint.
   */
  banner(port) {
    const paired = this.pairing.isPaired();
    const lines = [
      '',
      `LinkOK Hub ${this.version} is running`,
      `  settings   http://127.0.0.1:${port}`,
      `  LAN        http://${this.lanAddress}:${port}`,
      `  health     http://127.0.0.1:${port}/health`,
      `  data       ${this.layout.dataDir}`,
      `  paired     ${paired ? 'yes' : 'no'}`,
      `  helper     ${this.helper.describe().status}`,
    ];

    if (!paired) {
      const { code, expiresAt } = this.pairing.mintCode();
      const payload = this.pairing.qrPayload(this.lanAddress, port, code);
      // Remember it: the helper is almost certainly not ready yet at banner time,
      // so this call usually cannot draw anything. `_showPendingPairingQr` retries
      // the moment the helper reports ready.
      this._pendingPairingQr = { payload, code, expiresAt };
      if (this.helper.isRunning) this.helper.showQr(payload);
      // Also log it. The console banner is invisible when the Hub is started by the
      // GUI launcher (no console attached), so without this the pairing link would
      // exist only in a text box — impossible to retrieve for scripting or support.
      this.logger.info(`pairing code ${code} (expires ${new Date(expiresAt).toISOString()}): ${payload}`);
      lines.push(
        '',
        '  ── 首次配对 ──────────────────────────────────',
        `  配对码     ${code}`,
        `  有效期     ${new Date(expiresAt).toLocaleTimeString('zh-CN')} 前`,
        `  二维码内容 ${payload}`,
        '  手机上装 LinkOK → 扫码，或粘贴上面这行',
        '  ─────────────────────────────────────────────',
      );
    } else {
      // 已配对时也要留一条可用的配对链接。
      //
      // 为什么：手机可能重装、清数据、或换机，此时它需要一个新码，而用户
      // 手里唯一的界面就是 GUI 窗口。之前这里什么都不打印，导致窗口里
      // 二维码是空白白框、「复制配对链接」复制不到东西 —— 唯一的出路
      // 变成了先删 device.json 再重启，普通用户根本想不到。
      //
      // 只在日志里写，不在控制台横幅里写：避免已配对的用户误以为还要重新扫。
      const { code, expiresAt } = this.pairing.mintCode();
      const payload = this.pairing.qrPayload(this.lanAddress, port, code);
      this.logger.info(`pairing code ${code} (spare, for a re-pairing; expires ${new Date(expiresAt).toISOString()}): ${payload}`);
    }

    lines.push('');
    process.stdout.write(`${lines.join('\n')}\n`);
  }

  /** @returns {Promise<void>} */
  async shutdown() {
    this.logger.info('shutting down');
    if (this.offlineTimer) {
      clearTimeout(this.offlineTimer);
      this.offlineTimer = null;
    }
    if (this.link) this.link.close('hub-shutdown');
    this.history.close();
    const http = this.http;
    const helper = this.helper;
    const results = await Promise.allSettled([http.close(), helper.stop()]);
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('shutdown step failed', { error: String(result.reason) });
      }
    }
    this.logger.info('goodbye');
  }
}

/**
 * The QR library is optional: without it the pairing code still works and the
 * settings page renders the payload as text.
 * @param {import('./logger').Logger} logger
 * @returns {any|null}
 */
function safeRequireQrcode(logger) {
  try {
    // Resolved from `pc/node_modules`; a missing optional dependency is fine.
    return require('qrcode');
  } catch (err) {
    logger.warn('qrcode module is not installed; QR images will be omitted', {
      error: /** @type {Error} */ (err).message,
    });
    return null;
  }
}

module.exports = { Hub, OFFLINE_NOTIFY_MS };


