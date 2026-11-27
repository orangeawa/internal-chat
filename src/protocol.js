'use strict';

/**
 * 信令协议：服务端与浏览器之间只传这些类型码。
 *
 * 数字沿用历史值，保证新旧客户端可以共存。
 */

/** 服务端 -> 客户端 */
const TO_CLIENT = {
  REGISTER: '1001', // 注册成功，下发自己的 id / 房间 / TURN 配置
  ROOM_INFO: '1002', // 房间内用户列表
  JOINED_ROOM: '1003', // 自己已加入房间（收到后开始建立 P2P 连接）
  CANDIDATE: '1004', // ICE candidate 转发
  OFFER: '1005', // offer 转发
  ANSWER: '1006', // answer 转发
  NICKNAME_UPDATED: '1007', // 昵称变更广播
};

/** 客户端 -> 服务端 */
const FROM_CLIENT = {
  CANDIDATE: '9001',
  OFFER: '9002',
  ANSWER: '9003',
  UPDATE_NICKNAME: '9004',
  KEEPALIVE: '9999',
};

/** 单条信令消息的最大字节数（只含 SDP / candidate，正常远小于此值） */
const MAX_SIGNAL_MESSAGE_BYTES = 10 * 1024;

/** 房间号 / 密码的最大长度 */
const MAX_ROOM_FIELD_LENGTH = 32;

module.exports = {
  TO_CLIENT,
  FROM_CLIENT,
  MAX_SIGNAL_MESSAGE_BYTES,
  MAX_ROOM_FIELD_LENGTH,
};
