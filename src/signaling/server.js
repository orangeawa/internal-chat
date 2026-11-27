'use strict';

/**
 * WebSocket 信令服务。
 *
 * 只做三件事：房间归属、在线列表广播、SDP/candidate 转发。
 * 所有 JSON 解析与异常都在这里兜住：解析失败只丢弃该条消息，绝不抛出。
 */

const { WebSocketServer } = require('ws');
const { TO_CLIENT, FROM_CLIENT, MAX_SIGNAL_MESSAGE_BYTES, MAX_ROOM_FIELD_LENGTH } = require('../protocol');
const { getRoomKey, normalizeIp } = require('../net/ip');
const { logger } = require('../logger');

/**
 * 从请求头拿客户端 IP。
 * X-Forwarded-For 可能是 "client, proxy1, proxy2"，取第一个。
 */
function clientIpOf(request, socket) {
  const forwarded = request.headers['x-forwarded-for'];
  const realIp = request.headers['x-real-ip'];
  const raw = (typeof forwarded === 'string' && forwarded) || (typeof realIp === 'string' && realIp) || '';
  if (raw) {
    return normalizeIp(raw);
  }
  const remote = socket._socket?.remoteAddress ?? '';
  return normalizeIp(remote);
}

/**
 * 解析 /ws/:roomId/:pwd（兼容旧版 /ws、/ws/、/ws/:roomId）。
 * @returns {{ roomId: string|null, pwd: string|null }}
 */
function parseRoomPath(url = '') {
  const clean = url.split('?')[0].replace(/^\/+/, '');
  const parts = clean.split('/');
  // parts[0] 恒为 'ws'（或空）
  const pick = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_ROOM_FIELD_LENGTH) return null;
    return trimmed;
  };
  let roomId = pick(parts[1]);
  const pwd = pick(parts[2]);
  if (roomId === 'ws') {
    roomId = null; // 旧版本路径
  }
  return { roomId, pwd };
}

/** 校验房间密码；不通过时降级为「内网/公网」房间（与旧版行为一致） */
function resolveRoom(roomId, pwd, roomConfig) {
  if (!roomId) {
    return { roomId: null, turns: null };
  }
  const room = roomConfig.get(roomId);
  if (!room || !pwd || room.pwd.toLowerCase() !== pwd.toLowerCase()) {
    return { roomId: null, turns: null };
  }
  return { roomId, turns: room.turns };
}

class SignalingServer {
  /**
   * @param {import('http').Server} httpServer
   * @param {object} deps
   * @param {import('../users/registry').UserRegistry} deps.registry
   * @param {Map<string, {pwd: string, turns: any[]}>} deps.roomConfig
   */
  constructor(httpServer, { registry, roomConfig }) {
    this.registry = registry;
    this.roomConfig = roomConfig;
    this.wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_SIGNAL_MESSAGE_BYTES });
    this.wss.on('connection', (socket, request) => this.#onConnection(socket, request));
    this.wss.on('error', (err) => logger.error('WebSocket 服务错误:', err));
  }

  #onConnection(socket, request) {
    const ip = clientIpOf(request, socket);
    const { roomId: requestedRoomId, pwd } = parseRoomPath(request.url);
    const { roomId, turns } = resolveRoom(requestedRoomId, pwd, this.roomConfig);
    const roomKey = getRoomKey(ip, roomId);

    const user = this.registry.register({ roomKey, ip, roomId, socket, nickname: cookieNickname(request) });
    const label = this.#label(user);

    this.#send(socket, TO_CLIENT.REGISTER, { id: user.id, roomId, turns, ip });
    logger.log(`${label} connected (room=${roomKey})`);

    // 给房间里每个人推一遍最新列表
    this.#broadcastRoomInfo(roomKey);
    this.#send(socket, TO_CLIENT.JOINED_ROOM, { id: user.id });

    socket.on('message', (raw) => this.#onMessage(socket, roomKey, user, raw));
    socket.on('close', () => this.#onGone(roomKey, user));
    socket.on('error', (err) => {
      logger.warn(`${this.#label(user)} socket error: ${err.message}`);
      this.#onGone(roomKey, user);
    });
  }

  #onMessage(socket, roomKey, user, raw) {
    // 每条消息都算活跃
    this.registry.touch(socket);

    const text = typeof raw === 'string' ? raw : raw.toString();
    if (!text || text.length > MAX_SIGNAL_MESSAGE_BYTES) {
      return;
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      // 静默丢弃：旧版这里会 destructure null 直接把整个进程打挂
      logger.warn(`丢弃非法 JSON 信令 (${this.#label(user)})`);
      return;
    }
    if (!message || typeof message !== 'object') {
      return;
    }

    const type = String(message.type ?? '');
    if (type === FROM_CLIENT.KEEPALIVE) {
      return;
    }

    // 转发类消息：必须带 uid / targetId，且 uid 必须是发送者自己
    const targetId = message.targetId == null ? '' : String(message.targetId);
    const claimedUid = message.uid == null ? '' : String(message.uid);
    if (!targetId || !claimedUid) {
      return;
    }
    if (claimedUid !== user.id) {
      // 不允许冒用别人的 id
      return;
    }
    const target = this.registry.get(roomKey, targetId);
    if (!target) {
      return;
    }
    const data = message.data && typeof message.data === 'object' ? message.data : {};

    switch (type) {
      case FROM_CLIENT.UPDATE_NICKNAME: {
        const nickname = typeof data.nickname === 'string' ? data.nickname.slice(0, 32) : '';
        if (!nickname) return;
        if (!this.registry.updateNickname(roomKey, user.id, nickname)) return;
        for (const peer of this.registry.list(roomKey)) {
          this.#send(peer.socket, TO_CLIENT.NICKNAME_UPDATED, { id: user.id, nickname });
        }
        return;
      }
      case FROM_CLIENT.CANDIDATE:
        if (!data.candidate) return;
        this.#send(target.socket, TO_CLIENT.CANDIDATE, { targetId: user.id, candidate: data.candidate });
        return;
      case FROM_CLIENT.OFFER:
        if (!data.targetAddr) return;
        this.#send(target.socket, TO_CLIENT.OFFER, { targetId: user.id, offer: data.targetAddr });
        return;
      case FROM_CLIENT.ANSWER:
        if (!data.targetAddr) return;
        this.#send(target.socket, TO_CLIENT.ANSWER, { targetId: user.id, answer: data.targetAddr });
        return;
      default:
        return;
    }
  }

  #onGone(roomKey, user) {
    const removed = this.registry.unregister(roomKey, user.id);
    if (!removed) {
      return; // close 与 error 可能都触发，保证只处理一次
    }
    logger.log(`${this.#label(user)} disconnected`);
    this.#broadcastRoomInfo(roomKey);
  }

  #broadcastRoomInfo(roomKey) {
    const list = this.registry.list(roomKey).map((u) => ({ id: u.id, nickname: u.nickname }));
    for (const peer of this.registry.list(roomKey)) {
      this.#send(peer.socket, TO_CLIENT.ROOM_INFO, list);
    }
  }

  #label(user) {
    return `${user.id}@${user.ip}${user.roomId ? '/' + user.roomId : ''}`;
  }

  #send(socket, type, data) {
    if (socket.readyState !== socket.OPEN) {
      return;
    }
    socket.send(JSON.stringify({ type, data }));
  }

  /** 周期性清理僵尸连接（客户端每 10 秒发一次 9999） */
  startHeartbeatSweeper(intervalMs = 30 * 1000) {
    this.sweeper = setInterval(() => {
      for (const { roomKey, user } of this.registry.evictIdle()) {
        logger.warn(`${this.#label(user)} 空闲超时，已清理`);
        try {
          user.socket.terminate();
        } catch { /* ignore */ }
        this.#broadcastRoomInfo(roomKey);
      }
    }, intervalMs);
    this.sweeper.unref?.();
  }

  close() {
    clearInterval(this.sweeper);
    this.wss.close();
  }
}

function cookieNickname(request) {
  const cookie = request.headers?.cookie;
  if (!cookie) return null;
  const match = cookie.match(/nickname=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

module.exports = { SignalingServer, parseRoomPath, clientIpOf };
