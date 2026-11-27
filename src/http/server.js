'use strict';

/**
 * HTTP 服务入口：只负责端口、路由分发，以及把未捕获的异常挡住，
 * 避免单个畸形请求把整个进程带走。
 */

const http = require('http');
const { serveStatic } = require('./static');
const { logger } = require('../logger');

/**
 * @param {{ port: number, wwwRoot: string }} options
 * @returns {import('http').Server}
 */
function createHttpServer({ wwwRoot }) {
  const server = http.createServer((req, res) => {
    try {
      serveStatic(req, res, { root: wwwRoot });
    } catch (err) {
      logger.error('处理 HTTP 请求失败:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('Internal Server Error');
    }
  });

  server.on('clientError', (err, socket) => {
    // 畸形请求行/请求头，直接断开，不影响其他连接
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  return server;
}

module.exports = { createHttpServer };
