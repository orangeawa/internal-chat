/**
 * 前端共享常量与工具。
 *
 * 挂到 window.FGDX 上，各模块按需引用（脚本用普通 <script> 加载，
 * 不引入打包步骤，保持「下载源码即可运行」的使用方式）。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX || (global.FGDX = {});

  /** 信令类型码，必须与服务端 src/protocol.js 保持一致 */
  FGDX.SIGNAL = {
    REGISTER: '1001',
    ROOM_INFO: '1002',
    JOINED_ROOM: '1003',
    CANDIDATE: '1004',
    OFFER: '1005',
    ANSWER: '1006',
    NICKNAME_UPDATED: '1007',

    SEND_CANDIDATE: '9001',
    SEND_OFFER: '9002',
    SEND_ANSWER: '9003',
    SEND_NICKNAME: '9004',
    KEEPALIVE: '9999',
  };

  FGDX.connectionStates = {
    DISCONNECTED: 'disconnected',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    FAILED: 'failed',
    CLOSED: 'closed',
  };

  /** 文件传输分片大小。8KB 在弱网下更稳，太大容易在信令通道上抖动 */
  FGDX.FILE_CHUNK_SIZE = 8 * 1024;

  /** 传输控制消息前缀，避免和用户聊天文本混淆 */
  FGDX.TRANSFER = {
    START: '##FILE_S##',
    START_ACK: '##FILE_S_ACK##',
    END: '##FILE_E##',
    RECEIVED: '##FILE_RECEIVED##',
    CHUNK_INFO: '##CHUNK_INFO##',
    RETRY_REQUEST: '##RETRY_REQUEST##',
    PROGRESS_ACK: '##PROGRESS_ACK##',
  };

  FGDX.utils = {
    /** YYYY-MM-DD HH:mm:ss.SSS */
    timestamp(date = new Date()) {
      const pad = (n, len = 2) => String(n).padStart(len, '0');
      return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
        `${pad(date.getMilliseconds(), 3)}`
      );
    },

    formatSpeed(bytesPerSecond) {
      if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return '0 KB/s';
      }
      if (bytesPerSecond > 1024 * 1024) {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
      }
      return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
    },

    formatSize(bytes) {
      if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${bytes} B`;
    },

    escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    /** 读取 cookie 中的昵称（未解码） */
    readNicknameCookie() {
      const match = document.cookie.match(/nickname=([^;]+)/);
      if (!match) return '';
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return '';
      }
    },

    writeNicknameCookie(nickname) {
      document.cookie = `nickname=${encodeURIComponent(nickname)}; path=/; max-age=31536000`;
    },
  };

  /** 页面所在房间号：/roomId/... */
  FGDX.roomIdFromPath = function roomIdFromPath() {
    return (window.location.pathname.split('/')[1] || '').trim();
  };

  FGDX.isMobile = function isMobile() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  };
})(window);
