'use strict';

/**
 * 静态文件服务。
 *
 * 相比旧实现修掉的问题：
 *  - `path.join(dir, urlPath)` 后没有做前缀校验，`GET /../package.json`
 *    可以直接读到项目根目录下的任意文件（已实测可读到 room_pwd.json）。
 *  - `decodeURIComponent` 对畸形百分号编码会抛 URIError，且没有 try/catch，
 *    一个 `GET /%zz` 就能让整个服务进程退出（已实测）。
 *  - 旧的 try/catch 本身就是空的，catch 分支还写错了变量名。
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('../logger');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** 带哈希/版本号的资源可以长缓存，入口 HTML 必须每次校验 */
function cacheControlFor(ext, urlPath) {
  if (urlPath === '/index.html') {
    return 'no-cache';
  }
  if (ext === '.js' || ext === '.css') {
    return 'public, max-age=2592000';
  }
  return 'public, max-age=3600';
}

/**
 * 把 URL 路径安全地映射到 root 下的真实文件路径。
 * @returns {string|null} null 表示越界或非法
 */
function resolveSafePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // 畸形百分号编码
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const normalized = path.posix.normalize('/' + decoded.replace(/\\/g, '/'));
  if (normalized.includes('..')) {
    return null;
  }
  const abs = path.join(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  // 双保险：解析后的绝对路径必须仍在 root 下
  return abs === root || abs.startsWith(rootWithSep) ? abs : null;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ root: string }} options
 */
function serveStatic(req, res, { root }) {
  const rootDir = path.resolve(root);

  const sendError = (status, message) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return sendError(405, 'Method Not Allowed');
  }

  // 查询参数对静态资源无意义
  const rawPath = (req.url || '/').split('?')[0].split('#')[0];
  const requested = rawPath === '/' || rawPath === '' ? '/index.html' : rawPath;

  let filePath = resolveSafePath(rootDir, requested);
  if (!filePath) {
    logger.warn(`拒绝非法静态路径: ${rawPath}`);
    return sendError(400, 'Bad Request');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // 前端是单页应用，未知路径回退到 index.html；但带扩展名的资源直接 404，
      // 避免把 HTML 当成 JS 返回导致浏览器报奇怪的语法错误
      if (path.extname(requested)) {
        return sendError(404, 'Not Found');
      }
      filePath = path.join(rootDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', cacheControlFor(ext, requested));
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'HEAD') {
      res.statusCode = 200;
      return res.end();
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', (streamErr) => {
      logger.error(`读取静态文件失败 (${filePath}): ${streamErr.message}`);
      if (!res.headersSent) {
        sendError(500, 'Internal Server Error');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

module.exports = { serveStatic, resolveSafePath, MIME_TYPES };
