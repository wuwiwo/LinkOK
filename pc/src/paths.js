'use strict';

/**
 * Where LinkOK keeps its state (PROTOCOL.md §8.1):
 *
 *   %LOCALAPPDATA%\LinkOK\
 *   ├── config.json
 *   ├── device.json          <- Token + bound Phone (see docs/README note)
 *   ├── history\
 *   │   ├── index.json
 *   │   └── 2026-11-25\
 *   └── logs\
 */

const path = require('node:path');

/** Env var that overrides the whole data directory (test / portable use). */
const DATA_DIR_ENV = 'LINKOK_DATA_DIR';

/**
 * @typedef {object} LinkokLayout
 * @property {string} dataDir
 * @property {string} configFile
 * @property {string} deviceFile
 * @property {string} historyDir
 * @property {string} indexFile
 * @property {string} logsDir
 * @property {string} tmpDir
 */

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute data directory
 */
function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV];
  if (typeof override === 'string' && override.trim() !== '') {
    return path.resolve(override);
  }
  const localAppData = env.LOCALAPPDATA;
  if (typeof localAppData === 'string' && localAppData.trim() !== '') {
    return path.join(localAppData, 'LinkOK');
  }
  const userProfile = env.USERPROFILE;
  if (typeof userProfile === 'string' && userProfile.trim() !== '') {
    return path.join(userProfile, 'AppData', 'Local', 'LinkOK');
  }
  throw new Error(
    `cannot resolve the LinkOK data directory: LOCALAPPDATA and USERPROFILE are unset. ` +
      `Set ${DATA_DIR_ENV} to choose a directory explicitly.`,
  );
}

/**
 * @param {string} dataDir
 * @returns {LinkokLayout}
 */
function layoutFor(dataDir) {
  const resolved = path.resolve(dataDir);
  const historyDir = path.join(resolved, 'history');
  return {
    dataDir: resolved,
    configFile: path.join(resolved, 'config.json'),
    deviceFile: path.join(resolved, 'device.json'),
    historyDir,
    indexFile: path.join(historyDir, 'index.json'),
    logsDir: path.join(resolved, 'logs'),
    tmpDir: path.join(resolved, 'tmp'),
  };
}

/**
 * Default helper binary location: `pc/helper/linkok-helper.exe` next to `src/`.
 * @returns {string}
 */
function defaultHelperPath() {
  return path.join(__dirname, '..', 'helper', 'linkok-helper.exe');
}

/**
 * Static settings page directory: `pc/public/`.
 * @returns {string}
 */
function defaultStaticDir() {
  return path.join(__dirname, '..', 'public');
}

module.exports = {
  DATA_DIR_ENV,
  resolveDataDir,
  layoutFor,
  defaultHelperPath,
  defaultStaticDir,
};
