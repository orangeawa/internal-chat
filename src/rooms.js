'use strict';

/**
 * 房间配置加载（room_pwd.json）。
 *
 * 文件位置：可执行文件所在目录（用 pkg 打包后 __dirname 是快照内路径，
 * 必须用 execPath 定位外部文件）。
 *
 * 格式：[{ roomId, pwd: 'md5(密码)', turns: [...], remark }]
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

function configDir() {
  return process.pkg ? path.dirname(process.execPath) : process.cwd();
}

/** 与打包后的行为保持一致：优先可执行文件所在目录，其次项目根目录 */
function candidatePaths() {
  const dirs = [
    process.pkg ? path.dirname(process.execPath) : null,
    process.cwd(),
    path.join(__dirname, '..'),
  ].filter(Boolean);
  return [...new Set(dirs.map((d) => path.join(d, 'room_pwd.json')))];
}

function loadRoomConfig() {
  /** @type {Map<string, { pwd: string, turns: any }>} */
  const rooms = new Map();

  let raw = null;
  let usedPath = null;
  for (const file of candidatePaths()) {
    try {
      raw = fs.readFileSync(file, 'utf8');
      usedPath = file;
      break;
    } catch (e) {
      // 没有配置文件属于正常情况
    }
  }

  if (raw === null) {
    return rooms;
  }

  let list;
  try {
    list = JSON.parse(raw);
  } catch (e) {
    logger.error(`房间配置解析失败 (${usedPath}): ${e.message}`);
    return rooms;
  }
  if (!Array.isArray(list)) {
    logger.error(`房间配置格式错误 (${usedPath}): 顶层应为数组`);
    return rooms;
  }

  for (const item of list) {
    if (!item || typeof item.roomId !== 'string' || !item.roomId) {
      continue;
    }
    rooms.set(item.roomId, {
      pwd: typeof item.pwd === 'string' ? item.pwd : '',
      turns: Array.isArray(item.turns) ? item.turns : [],
    });
  }

  if (rooms.size > 0) {
    logger.log(`加载房间数据: ${[...rooms.keys()].join(',')}`);
  }
  return rooms;
}

module.exports = { loadRoomConfig };
