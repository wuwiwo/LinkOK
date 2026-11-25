'use strict';

/**
 * Resolution of the Windows screenshot folder (SPEC §5.2 / PROTOCOL §7):
 * the `User Shell Folders` value `{374DE290-123F-4565-9164-39C4925E467B}`,
 * which OneDrive may have redirected, so it must never be hard-coded.
 *
 * Reading the registry needs `reg.exe`, and the dev sandbox forbids capturing a
 * child process's stdout (EPERM on pipes). The official way to read the
 * registry from Node without spawning anything is Windows' `winreg` WMI class
 * via a PowerShell child — also a pipe — so this module reads the registry
 * through a short-lived PowerShell process with **file redirection** when the
 * caller supplies a runner, and otherwise returns the documented fallback.
 *
 * In practice the Hub only uses `screenshotDir` to tell the C# helper where to
 * watch, and the helper resolves the registry itself; this module exists so the
 * settings page can show a resolved value. It degrades to '' (unresolved)
 * instead of guessing a path that might not exist.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** The known-folder GUID for the screenshot directory. */
const SCREENSHOTS_GUID = '{374DE290-123F-4565-9164-39C4925E467B}';
const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/**
 * @param {string} value raw registry value which may contain %USERPROFILE% etc.
 * @returns {string}
 */
function expandEnvironment(value) {
  return value.replace(/%([^%]+)%/g, (match, name) => {
    const key = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === String(name).toUpperCase());
    return key ? String(process.env[key]) : match;
  });
}

/**
 * Resolve the screenshot folder from the registry.
 *
 * @param {object} [options]
 * @param {import('node:child_process').execFileSync} [options.execFileSync]
 *   injectable runner; when omitted the registry is not consulted
 * @param {import('./logger').Logger} [options.logger]
 * @returns {string} absolute path, or '' when it could not be resolved
 */
function resolveScreenshotDir({ execFileSync = null, logger = null } = {}) {
  if (typeof execFileSync !== 'function') return '';

  const outFile = path.join(os.tmpdir(), `linkok-reg-${process.pid}-${Date.now()}.txt`);
  const errFile = `${outFile}.err`;
  try {
    // `reg query` writes to a file via the shell, never to a captured pipe.
    execFileSync(
      'cmd.exe',
      ['/c', `reg query "${REG_PATH}" /v ${SCREENSHOTS_GUID} > "${outFile}" 2> "${errFile}"`],
      { windowsHide: true, timeout: 10_000 },
    );
    const raw = fs.readFileSync(outFile, 'utf8');
    // Format: "    {374DE290-...}    REG_EXPAND_SZ    C:\Users\x\Pictures\Screenshots"
    const line = raw
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.toUpperCase().includes(SCREENSHOTS_GUID.toUpperCase()));
    if (!line) return '';
    const match = line.match(/REG_(?:EXPAND_)?SZ\s+(.+)$/i);
    if (!match) return '';
    const value = expandEnvironment(match[1].trim());
    if (value === '') return '';
    return path.resolve(value);
  } catch (err) {
    if (logger) {
      logger.debug('screenshot folder could not be resolved from the registry', {
        error: /** @type {Error} */ (err).message,
      });
    }
    return '';
  } finally {
    for (const file of [outFile, errFile]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // The temp file may never have been created; nothing to clean up.
      }
    }
  }
}

module.exports = { resolveScreenshotDir, expandEnvironment, SCREENSHOTS_GUID, REG_PATH };
