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
 *
 * 性能相关（局域网 + Cloudflare 隧道场景）：
 *  - 文本资源按 gzip 预压缩并落盘缓存，启动时不压缩，首次请求后复用。
 *  - 用 ETag / Content-Length 支持 304 和断点，避免重复传输。
 *  - 入口 HTML 走 no-cache，带 ?v= 的资源走长缓存。
 *  - 可选的 CDN 直连：设置 STATIC_ORIGIN 后，静态资源 302 到该地址，
 *    Node 只处理 /ws 信令，静态资源不再穿过隧道。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream');
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

/** 值得压缩的类型：二进制（图片/ico）gzip 基本没收益 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);
const GZIP_LEVEL = 9;
/** 小于这个体积不做压缩（省 CPU，也避免小文件反而变大） */
const GZIP_MIN_BYTES = 1024;

/** 带版本号的资源可以长缓存，入口 HTML 必须每次校验 */
function cacheControlFor(ext, urlPath) {
  if (urlPath === '/index.html') {
    return 'no-cache';
  }
  if (ext === '.js' || ext === '.css') {
    return 'public, max-age=2592000, immutable';
  }
  return 'public, max-age=86400';
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
 * 静态资源服务实例。
 *
 * 缓存内容：{ filePath, mtimeMs, size, gzip?: Buffer, etag }
 * 文件改动后（mtime 变化）自动失效，所以改完前端刷新一次就能看到效果。
 */
class StaticServer {
  /**
   * @param {{ root: string, cdnOrigin?: string }} options
   */
  constructor({ root, cdnOrigin }) {
    this.root = path.resolve(root);
    this.cdnOrigin = cdnOrigin ? cdnOrigin.replace(/\/+$/, '') : '';
    this.cache = new Map();
  }

  handle(req, res) {
    try {
      this.#handle(req, res);
    } catch (err) {
      logger.error('处理静态请求失败:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('Internal Server Error');
    }
  }

  #handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return this.#sendError(res, 405, 'Method Not Allowed');
    }

    // 查询参数对静态资源无意义
    const rawPath = (req.url || '/').split('?')[0].split('#')[0];
    const requested = rawPath === '/' || rawPath === '' ? '/index.html' : rawPath;

    const filePath = resolveSafePath(this.root, requested);
    if (!filePath) {
      logger.warn(`拒绝非法静态路径: ${rawPath}`);
      return this.#sendError(res, 400, 'Bad Request');
    }

    // 可选：静态资源直连 CDN / 对象存储，Node 只负责信令
    if (this.cdnOrigin && requested !== '/index.html') {
      res.statusCode = 302;
      res.setHeader('Location', `${this.cdnOrigin}${requested}`);
      res.setHeader('Cache-Control', 'no-cache');
      return res.end();
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // 前端是单页应用，未知路径回退到 index.html；但带扩展名的资源直接 404，
        // 避免把 HTML 当成 JS 返回导致浏览器报奇怪的语法错误
        if (path.extname(requested)) {
          return this.#sendError(res, 404, 'Not Found');
        }
        return this.#serveFile(path.join(this.root, 'index.html'), req, res, '/index.html');
      }
      this.#serveFile(filePath, req, res, requested);
    });
  }

  async #serveFile(filePath, req, res, requested) {
    let stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      return this.#sendError(res, 404, 'Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const cacheControl = cacheControlFor(ext, requested);

    res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // 304：浏览器已有最新版本，连响应体都不用发
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
      res.statusCode = 304;
      return res.end();
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    // 只有文本类资源且客户端接受 gzip 时才压缩；否则按原文件发送
    const gzip = acceptsGzip && COMPRESSIBLE.has(ext) && stats.size >= GZIP_MIN_BYTES
      ? await this.#gzipped(filePath, stats)
      : null;

    if (gzip) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', gzip.length);
      res.statusCode = 200;
      return res.end(req.method === 'HEAD' ? undefined : gzip);
    }

    res.setHeader('Content-Length', stats.size);
    res.statusCode = 200;
    if (req.method === 'HEAD') {
      return res.end();
    }

    pipeline(fs.createReadStream(filePath), res, (streamErr) => {
      if (streamErr && streamErr.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        logger.error(`读取静态文件失败 (${filePath}): ${streamErr.message}`);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      }
    });
  }

  /** 返回 gzip 后的内容，按 mtime 缓存，避免每次请求重复压 */
  async #gzipped(filePath, stats) {
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.gzip;
    }
    try {
      const raw = await fs.promises.readFile(filePath);
      const gzip = await new Promise((resolve, reject) => {
        zlib.gzip(raw, { level: GZIP_LEVEL }, (err, out) => (err ? reject(err) : resolve(out)));
      });
      this.cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, gzip });
      return gzip;
    } catch (err) {
      logger.warn(`压缩 ${filePath} 失败: ${err.message}`);
      return null;
    }
  }

  #sendError(res, status, message) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(message);
  }
}

module.exports = { StaticServer, resolveSafePath, MIME_TYPES, cacheControlFor };
