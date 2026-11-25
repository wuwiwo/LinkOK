'use strict';

/**
 * Static serving for the settings page (`pc/public/`), PROTOCOL.md §1.
 *
 * `GET /` is one of exactly three unauthenticated endpoints (PROTOCOL §2) and
 * returns the page shell. Every other file under `pc/public/` is served from
 * its own path so the page can pull in CSS/JS.
 *
 * Security notes that matter even on a LAN:
 *  - only files resolving *inside* `pc/public/` are served; `..`, absolute paths
 *    and encoded separators are rejected after normalisation;
 *  - nothing is served with a guessed `Content-Type: text/html` for a JS file,
 *    because a mislabelled file is an XSS foothold;
 *  - the response is `no-store` so a Half-updated settings page never shows
 *    stale JS against new markup.
 */

const fs = require('node:fs');
const path = require('node:path');

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

/** Shown when `pc/public/index.html` has not been written yet. */
const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LinkOK</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0;
         display: grid; place-items: center; min-height: 100vh; background: Canvas; color: CanvasText; }
  main { max-width: 32rem; padding: 2rem; background: color-mix(in oklab, CanvasText 6%, Canvas);
         border-radius: 28px; }
  h1 { font-size: 1.5rem; margin: 0 0 .5rem; }
  p { line-height: 1.6; margin: .5rem 0; }
  code { font-family: ui-monospace, Consolas, monospace; background: color-mix(in oklab, CanvasText 10%, Canvas);
         padding: .1rem .35rem; border-radius: 8px; }
</style>
</head>
<body>
<main>
  <h1>LinkOK Hub 正在运行</h1>
  <p>设置页尚未生成：<code>pc/public/index.html</code> 不存在。</p>
  <p>Hub 本身工作正常。<code>GET /health</code>、配对接口与 WebSocket <code>/ws</code> 均可用。</p>
</main>
</body>
</html>
`;

/**
 * @param {string} urlPath pathname from the request, already URL-decoded
 * @param {string} rootDir absolute `pc/public`
 * @returns {string|null} absolute path of the file to serve, or null
 */
function resolveStaticPath(urlPath, rootDir) {
  let decoded = urlPath;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    // A malformed percent-escape is a bad request, never a traversal vector.
    return null;
  }
  if (decoded.includes('\0')) return null;
  // Reject the obvious traversal forms before touching the filesystem.
  if (decoded.split(/[\\/]/).some((segment) => segment === '..')) return null;

  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  const absolute = path.resolve(rootDir, relative);
  const rootResolved = path.resolve(rootDir);
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : `${rootResolved}${path.sep}`;
  if (absolute !== rootResolved && !absolute.startsWith(rootWithSep)) return null;
  return absolute;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Serve a static file. Returns false when the caller should fall through to a
 * 404 (the file does not exist, or the path was rejected).
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {object} [options]
 * @param {boolean} [options.headOnly]
 * @returns {boolean}
 */
function sendStaticFile(res, filePath, { headOnly = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
  if (!stat.isFile()) return false;

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // The page is same-origin only; framing it is never legitimate.
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  if (headOnly) {
    res.end();
    return true;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    // Headers are already out; the only honest signal left is to drop the socket.
    res.destroy(/** @type {Error} */ (err));
  });
  stream.pipe(res);
  return true;
}

/**
 * @param {import('node:http').ServerResponse} res
 */
function sendPlaceholderPage(res) {
  const body = Buffer.from(PLACEHOLDER_HTML, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

module.exports = {
  MIME_TYPES,
  PLACEHOLDER_HTML,
  resolveStaticPath,
  contentTypeFor,
  sendStaticFile,
  sendPlaceholderPage,
};
