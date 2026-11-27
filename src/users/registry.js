'use strict';

/**
 * 在线用户注册表。
 *
 * 只保存「谁在线、在哪个房间、昵称是什么」，不涉及任何 WebRTC 细节。
 *
 * 相比旧实现修掉的几个问题：
 *  - id 旧实现是「随机 2 位 + 毫秒 3 位」并且去重判断写错了（拿 data[id]
 *    去查一个数组），大量用户同时进入时 id 只有 100×1000 种可能，容易撞号；
 *    撞号后 getUser() 返回第一个匹配项，消息会串到别人身上。
 *  - getUser() 在房间 key 不存在时会抛 TypeError。
 *  - unregisterUser() 在 chat 服务端异常时会被重复调用。
 */

const crypto = require('crypto');

/** 在线连接的最长空闲时间（毫秒）。超过则视为僵尸连接，由心跳清理。 */
const IDLE_TIMEOUT_MS = 60 * 1000;

class UserRegistry {
  /**
   * @param {{ idleTimeoutMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    /** @type {Map<string, Map<string, User>>} roomKey -> (userId -> user) */
    this.rooms = new Map();
    /** @type {Map<string, User>} 反查，便于按 socket 清理 */
    this.bySocket = new Map();
  }

  /**
   * @param {object} params
   * @param {string} params.roomKey
   * @param {string} params.ip
   * @param {string|null} params.roomId 显式房间号（用于下发给前端）
   * @param {object} params.socket ws 实例
   * @param {string|null} params.nickname
   */
  register({ roomKey, ip, roomId, socket, nickname }) {
    const id = this.#createId();
    const user = {
      id,
      ip,
      roomId: roomId ?? null,
      socket,
      nickname: nickname ?? null,
      joinedAt: this.now(),
      lastSeenAt: this.now(),
    };

    let room = this.rooms.get(roomKey);
    if (!room) {
      room = new Map();
      this.rooms.set(roomKey, room);
    }
    room.set(id, user);
    this.bySocket.set(socket, user);
    return user;
  }

  /** 幂等：重复调用安全，返回是否真的删掉了 */
  unregister(roomKey, id) {
    const room = this.rooms.get(roomKey);
    if (!room || !room.has(id)) {
      return false;
    }
    const user = room.get(id);
    room.delete(id);
    this.bySocket.delete(user.socket);
    if (room.size === 0) {
      this.rooms.delete(roomKey);
    }
    return true;
  }

  /** 按 socket 反查用户（断线时用，避免依赖闭包里的状态） */
  getBySocket(socket) {
    return this.bySocket.get(socket) ?? null;
  }

  /** @returns {Array<object>} 房间内所有用户（包含 socket，调用方自行决定下发什么） */
  list(roomKey) {
    const room = this.rooms.get(roomKey);
    return room ? [...room.values()] : [];
  }

  /** @returns {object|null} */
  get(roomKey, id) {
    const room = this.rooms.get(roomKey);
    return room?.get(id) ?? null;
  }

  updateNickname(roomKey, id, nickname) {
    const user = this.get(roomKey, id);
    if (!user) {
      return false;
    }
    user.nickname = nickname;
    return true;
  }

  touch(socket) {
    const user = this.bySocket.get(socket);
    if (user) {
      user.lastSeenAt = this.now();
    }
  }

  /**
   * 清理超时未活动的连接。
   * @returns {Array<{ roomKey: string, user: object }>} 被清理的用户
   */
  evictIdle() {
    const now = this.now();
    const evicted = [];
    for (const [roomKey, room] of this.rooms) {
      for (const user of room.values()) {
        if (now - user.lastSeenAt > this.idleTimeoutMs) {
          evicted.push({ roomKey, user });
        }
      }
    }
    for (const { roomKey, user } of evicted) {
      this.unregister(roomKey, user.id);
    }
    return evicted;
  }

  #createId() {
    // 4 位 ID，和旧版长度一致（前端按字符串展示，不做数值运算）
    for (let attempt = 0; attempt < 1000; attempt++) {
      const id = String(crypto.randomInt(1000, 10000));
      let taken = false;
      for (const room of this.rooms.values()) {
        if (room.has(id)) {
          taken = true;
          break;
        }
      }
      if (!taken) {
        return id;
      }
    }
    // 极端情况下（4 位空间被占满）退化为更长 id
    return crypto.randomBytes(6).toString('hex');
  }
}

module.exports = { UserRegistry, IDLE_TIMEOUT_MS };
