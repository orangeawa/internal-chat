'use strict';

/**
 * 发个东西 —— 服务端入口。
 *
 * 模块划分：
 *   src/logger.js          时间戳日志
 *   src/protocol.js        信令类型码
 *   src/rooms.js           room_pwd.json 加载
 *   src/net/ip.js          客户端 IP 归组（决定进哪个房间）
 *   src/users/registry.js  在线用户表
 *   src/http/static.js     静态文件（www/）
 *   src/signaling/server.js WebSocket 信令转发
 */

const path = require('path');
const { installTimestampedConsole, logger } = require('./src/logger');
const { loadRoomConfig } = require('./src/rooms');
const { UserRegistry } = require('./src/users/registry');
const { createHttpServer } = require('./src/http/server');
const { SignalingServer } = require('./src/signaling/server');

installTimestampedConsole();

const DEFAULT_PORT = 8081;
const WWW_ROOT = path.join(__dirname, 'www');

function parsePort(argv) {
  const raw = argv[2];
  if (raw === undefined) {
    return DEFAULT_PORT;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    logger.error(`端口不合法: ${raw}，回退到 ${DEFAULT_PORT}`);
    return DEFAULT_PORT;
  }
  return port;
}

function main() {
  const port = parsePort(process.argv);

  const roomConfig = loadRoomConfig();
  const registry = new UserRegistry();
  const httpServer = createHttpServer({ wwwRoot: WWW_ROOT });
  const signaling = new SignalingServer(httpServer, { registry, roomConfig });
  signaling.startHeartbeatSweeper();

  httpServer.on('error', (err) => {
    logger.error(`HTTP 服务错误: ${err.message}`);
    process.exitCode = 1;
  });

  httpServer.listen(port, () => {
    logger.log(`server start on port ${port}`);
  });

  const shutdown = (signal) => {
    logger.log(`收到 ${signal}，正在退出...`);
    signaling.close();
    httpServer.close(() => process.exit(0));
    // 兜底：3 秒内没关干净就强退
    setTimeout(() => process.exit(0), 3000).unref?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 最后一道防线：不要让单个异常打挂整个服务
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常:', err);
});
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});

if (require.main === module) {
  main();
}

module.exports = { main, parsePort };
