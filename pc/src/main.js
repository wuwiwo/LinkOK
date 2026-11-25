#!/usr/bin/env node
'use strict';

/**
 * Entry point: `node pc/src/main.js`.
 *
 * Responsibilities kept deliberately small — everything else lives in `hub.js`:
 *  - resolve the data directory and start logging;
 *  - start the Hub, bind the port, print the banner;
 *  - turn port-in-use and permission failures into one clear Chinese message
 *    with the documented exit code, instead of a stack trace;
 *  - shut down cleanly on Ctrl+C, SIGTERM, window close, and when the Tray
 *    asks to quit.
 */

const { Hub } = require('./hub');
const { Logger } = require('./logger');
const { resolveDataDir, layoutFor } = require('./paths');

/** Read from package.json so the version has exactly one source of truth. */
const VERSION = (() => {
  try {
    return require('../package.json').version || '0.1.0';
  } catch (err) {
    process.stderr.write(`warning: could not read package.json version: ${/** @type {Error} */ (err).message}\n`);
    return '0.1.0';
  }
})();

const EXIT_PORT_IN_USE = 2;
const EXIT_STARTUP_FAILURE = 3;

/**
 * @param {string|undefined} value
 * @returns {number|null}
 */
function parsePortFlag(value) {
  if (value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return null;
  return parsed;
}

async function main() {
  /** @type {string} */
  let dataDir;
  try {
    dataDir = resolveDataDir(process.env);
  } catch (err) {
    process.stderr.write(`LinkOK Hub cannot start: ${/** @type {Error} */ (err).message}\n`);
    process.exitCode = EXIT_STARTUP_FAILURE;
    return;
  }

  const layout = layoutFor(dataDir);
  const logLevel = process.env.LINKOK_LOG_LEVEL || (process.argv.includes('--verbose') ? 'debug' : 'info');
  const logger = new Logger({ logsDir: layout.logsDir, level: /** @type {any} */ (logLevel) });
  if (logger.fileLoggingError) {
    logger.warn(`file logging is unavailable: ${logger.fileLoggingError}`);
  }
  logger.info(`LinkOK Hub ${VERSION} starting (Node ${process.version}, ${process.platform})`);
  logger.info(`data directory: ${layout.dataDir}`);

  // `--port` overrides config for this run only; it is not persisted, so a
  // one-off "try port 9000" never silently rewrites the user's setting.
  const portFlagIndex = process.argv.indexOf('--port');
  const portOverride = portFlagIndex !== -1 ? parsePortFlag(process.argv[portFlagIndex + 1]) : null;
  if (portFlagIndex !== -1 && portOverride === null) {
    process.stderr.write('usage: node pc/src/main.js [--port <1-65535>] [--no-helper] [--verbose]\n');
    process.exitCode = EXIT_STARTUP_FAILURE;
    logger.close();
    return;
  }

  const hub = new Hub({
    dataDir,
    logger,
    version: VERSION,
    portOverride,
    startHelper: !process.argv.includes('--no-helper'),
  });

  let shuttingDown = false;
  /** @param {number} [code] */
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await hub.shutdown();
    } catch (err) {
      logger.error('shutdown failed', { error: /** @type {Error} */ (err).message });
    }
    logger.close();
    process.exit(code);
  };

  try {
    await hub.init();
    const { port } = await hub.listen();
    hub.banner(port);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    if (code === 'EADDRINUSE') {
      const wanted = portOverride ?? hub.configStore.get().port;
      const message =
        `端口 ${wanted} 已被占用。请关闭占用该端口的程序，或用 --port 指定别的端口，` +
        '或在设置页修改端口后重启 Hub。';
      logger.error(message);
      process.stderr.write(`\nLinkOK Hub 启动失败：${message}\n\n`);
      process.exitCode = EXIT_PORT_IN_USE;
      await hub.shutdown();
      logger.close();
      return;
    }
    if (code === 'EACCES') {
      const message = '没有权限绑定该端口。请换用 1024 以上的端口，或以便利账户身份运行。';
      logger.error(message, { error: /** @type {Error} */ (err).message });
      process.stderr.write(`\nLinkOK Hub 启动失败：${message}\n\n`);
      process.exitCode = EXIT_STARTUP_FAILURE;
      await hub.shutdown();
      logger.close();
      return;
    }
    logger.error('startup failed', { error: /** @type {Error} */ (err).stack || String(err) });
    process.stderr.write(`\nLinkOK Hub 启动失败：${/** @type {Error} */ (err).message}\n\n`);
    process.exitCode = EXIT_STARTUP_FAILURE;
    logger.close();
    return;
  }

  hub.on('quit-requested', () => {
    void shutdown(0);
  });
  hub.on('open-settings', (url) => {
    logger.info(`open this URL to configure LinkOK: ${url}`);
  });

  process.on('SIGINT', () => {
    logger.info('SIGINT received');
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    void shutdown(0);
  });
  // Closing the console window (or a logoff) arrives as SIGHUP/SIGBREAK on Windows.
  process.on('SIGHUP', () => {
    logger.info('SIGHUP received');
    void shutdown(0);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', {
      error: reason instanceof Error ? reason.stack || reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    // A bug must not leave a half-dead Hub holding the port.
    logger.error('uncaught exception', { error: err.stack || err.message });
    void shutdown(EXIT_STARTUP_FAILURE);
  });
}

main().catch((err) => {
  process.stderr.write(`LinkOK Hub crashed: ${/** @type {Error} */ (err).stack || String(err)}\n`);
  process.exit(3);
});
