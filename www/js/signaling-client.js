/**
 * 信令连接（浏览器 <-> 服务端 WebSocket）。
 *
 * 关键修复：旧实现没有 onclose / 重连。只要信令通道断一次（切 WiFi、
 * 电脑休眠唤醒、服务端重启、代理超时），页面就永远收不到新的在线列表，
 * 表现为「明明在同一个局域网，对方却看不到我 / 我看不到对方，必须刷新」。
 * 这里做了指数退避重连，重连成功后自动重建所有 P2P 连接。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;
  const S = FGDX.SIGNAL;

  const KEEPALIVE_INTERVAL_MS = 10 * 1000;
  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 15 * 1000;

  class SignalingClient {
    /**
     * @param {{ roomId?: string, roomPassword?: string, handlers: object }} options
     */
    constructor(options) {
      this.roomId = options.roomId || '';
      this.roomPassword = options.roomPassword || '';
      this.handlers = options.handlers;

      this.socket = null;
      this.selfId = null;
      this.joinedRoomId = null;
      this.reconnectAttempts = 0;
      this.reconnectTimer = null;
      this.keepaliveTimer = null;
      this.closedByUser = false;
    }

    connect() {
      this.closedByUser = false;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      const path = [this.roomId, this.roomPassword].filter(Boolean).join('/');
      const url = `${protocol}://${host}/ws${path ? '/' + path : ''}`;

      let socket;
      try {
        socket = new WebSocket(url);
      } catch (err) {
        this.#scheduleReconnect();
        return;
      }
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectAttempts = 0;
        this.handlers.onOpen?.();
        this.#startKeepalive();
      };

      socket.onmessage = (event) => this.#onMessage(event.data);

      socket.onerror = () => {
        // onerror 之后必定有 onclose，重连逻辑统一放在 onclose
      };

      socket.onclose = () => {
        this.#stopKeepalive();
        this.selfId = null;
        this.handlers.onClose?.();
        if (!this.closedByUser) {
          this.#scheduleReconnect();
        }
      };
    }

    close() {
      this.closedByUser = true;
      clearTimeout(this.reconnectTimer);
      this.#stopKeepalive();
      if (this.socket) {
        try { this.socket.close(); } catch { /* ignore */ }
      }
    }

    send(payload) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        return false;
      }
      this.socket.send(JSON.stringify(payload));
      return true;
    }

    /** 给某个对端发信令；未连接时静默忽略（对端掉线本来就不需要信令） */
    signalTo(targetId, type, data) {
      return this.send({ uid: this.selfId, targetId, type, data });
    }

    #onMessage(raw) {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message || !message.type) return;
      const { type, data } = message;

      switch (type) {
        case S.REGISTER:
          this.selfId = data.id;
          this.handlers.onRegister?.(data);
          return;
        case S.ROOM_INFO:
          this.handlers.onRoomInfo?.(Array.isArray(data) ? data : []);
          return;
        case S.JOINED_ROOM:
          this.handlers.onJoinedRoom?.(data);
          return;
        case S.CANDIDATE:
          this.handlers.onCandidate?.(data);
          return;
        case S.OFFER:
          this.handlers.onOffer?.(data);
          return;
        case S.ANSWER:
          this.handlers.onAnswer?.(data);
          return;
        case S.NICKNAME_UPDATED:
          this.handlers.onNicknameUpdated?.(data);
          return;
        default:
          return;
      }
    }

    #startKeepalive() {
      this.#stopKeepalive();
      this.keepaliveTimer = setInterval(() => {
        this.send({ type: S.KEEPALIVE });
      }, KEEPALIVE_INTERVAL_MS);
    }

    #stopKeepalive() {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }

    #scheduleReconnect() {
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
      this.reconnectAttempts++;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    }
  }

  FGDX.SignalingClient = SignalingClient;
})(window);
