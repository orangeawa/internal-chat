/**
 * 一个对端（peer）的 WebRTC 连接封装。
 *
 * 只关心：建连、收发文本、收发文件、状态变化。
 * 信令怎么发由外部通过 FGDX.service 注入，本文件不直接碰 WebSocket。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;
  const CHUNK_SIZE = FGDX.FILE_CHUNK_SIZE;
  const MAX_BUFFERED = 64 * 1024;
  const BUFFERED_LOW = 16 * 1024;

  const DATACHANNEL_OPTIONS = {
    ordered: true,
    maxRetransmits: 10,
    bufferedAmountLowThreshold: BUFFERED_LOW,
  };

  /** 默认 ICE 配置；房间配置里的 TURN 会追加进来 */
  FGDX.rtcConfiguration = {
    iceServers: [
      // 公共 STUN：用于拿到公网映射地址
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:74.125.250.129:19302'] },
    ],
    iceTransportPolicy: 'all',
    // 候选池预热：首次建连更快，代价是页面打开时多收集几条候选
    iceCandidatePoolSize: 2,
  };

  class Peer {
    constructor(id, options = {}) {
      this.id = id;
      this.nickname = null;
      this.isMe = false;

      this.rtcConn = null;
      this.chatChannel = null;
      this.remoteSdp = null;
      this.connectionState = FGDX.connectionStates.DISCONNECTED;
      this.pendingCandidates = [];
      this.closed = false;

      this.onicecandidate = options.onicecandidate || (() => {});
      this.onmessage = options.onmessage || (() => {});
      this.onFile = options.onFile || (() => {});
      this.onConnectionStateChange = options.onConnectionStateChange || (() => {});
      this.onFileProgress = options.onFileProgress || (() => {});

      // 文本等待者：文件传输的 ACK 需要「等到某条特定消息」
      this._textWaiters = [];
      this._retryHandler = null;

      this.receiver = new FGDX.transfer.FileReceiver({
        onFile: (file) => this.onFile(file),
        onProgress: (received, total) => this.onFileProgress(received, total),
        sendText: (text) => this.sendText(text),
      });
      this.sender = new FGDX.transfer.FileSender({
        sendText: (text) => this.sendText(text),
        sendBinary: (buffer) => this.#sendBinary(buffer),
        waitForText: (predicate, timeoutMs, onTimeout) => this.#waitForText(predicate, timeoutMs, onTimeout),
        waitForDrain: () => this.#waitForDrain(),
        retryRequestHandler: {
          set: (fn) => { this._retryHandler = fn; },
        },
        onProgress: (sent, total) => this.onFileProgress(sent, total),
      });
    }

    get displayName() {
      return this.nickname || this.id;
    }

    isConnected() {
      if (!this.rtcConn || this.closed) return false;
      if (this.rtcConn.connectionState) {
        return this.rtcConn.connectionState === 'connected';
      }
      // Firefox 老版本没有 connectionState
      const ice = this.rtcConn.iceConnectionState;
      return (ice === 'connected' || ice === 'completed') && this.rtcConn.signalingState === 'stable';
    }

    // ---------- 建连 ----------

    /** 主动方：创建 offer */
    async createOffer() {
      this.#createPeerConnection();
      this.chatChannel = this.rtcConn.createDataChannel('chat', DATACHANNEL_OPTIONS);
      this.#bindDataChannel();
      const offer = await this.rtcConn.createOffer();
      await this.rtcConn.setLocalDescription(offer);
      return this.rtcConn.localDescription;
    }

    /** 被动方：收到 offer 后生成 answer */
    async acceptOffer(offerSdp) {
      if (this.rtcConn) {
        this.close();
      }
      this.#createPeerConnection();
      this.rtcConn.ondatachannel = (event) => {
        if (event.channel) {
          this.chatChannel = event.channel;
          this.#bindDataChannel();
        }
      };
      this.remoteSdp = new RTCSessionDescription({ type: 'offer', sdp: offerSdp });
      await this.rtcConn.setRemoteDescription(this.remoteSdp);
      this.#flushPendingCandidates();
      const answer = await this.rtcConn.createAnswer();
      await this.rtcConn.setLocalDescription(answer);
      return this.rtcConn.localDescription;
    }

    /** 主动方：收到 answer */
    async acceptAnswer(answerSdp) {
      if (!this.rtcConn) return false;
      if (this.rtcConn.signalingState !== 'have-local-offer') return false;
      this.remoteSdp = new RTCSessionDescription({ type: 'answer', sdp: answerSdp });
      await this.rtcConn.setRemoteDescription(this.remoteSdp);
      this.#flushPendingCandidates();
      return true;
    }

    /**
     * 收到 ICE candidate。
     *
     * 关键修复：candidate 可能比 offer/answer 先到 —— 发起方的 ICE 收集
     * 往往在建连的同一 tick 就开始跑，而 candidate 和 offer 是两条独立的
     * WebSocket 消息，不保证顺序。旧实现直接 addIceCandidate 会抛
     * InvalidStateError，调用处没有 catch，这个 candidate 就永久丢了。
     * 丢得多了就 ICE 失败：表现为「在线列表能看到对方，但一直连不上、
     * 发不了文件/消息」。这里先暂存，等 remoteDescription 就绪后再补上。
     */
    async addIceCandidate(candidate) {
      if (!candidate) return;
      if (!this.rtcConn || !this.rtcConn.remoteDescription) {
        this.pendingCandidates.push(candidate);
        return;
      }
      const applying = this._applyingCandidates || Promise.resolve();
      this._applyingCandidates = applying.then(async () => {
        try {
          await this.rtcConn.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.warn(`[peer ${this.id}] 添加 ICE candidate 失败: ${err.message}`);
        }
      });
    }

    #flushPendingCandidates() {
      const pending = this.pendingCandidates.splice(0);
      for (const candidate of pending) {
        this.addIceCandidate(candidate);
      }
    }

    #createPeerConnection() {
      if (this.rtcConn) {
        this.close();
      }
      this.closed = false;
      this.rtcConn = new RTCPeerConnection(FGDX.rtcConfiguration);

      this.rtcConn.onicecandidate = (event) => {
        if (event.candidate) {
          this.onicecandidate(event.candidate);
        }
      };

      this.rtcConn.onconnectionstatechange = () => {
        const state = this.getConnectionState();
        this.connectionState = state;
        this.onConnectionStateChange(state);
      };

      // Firefox 兼容：ICE 状态变化也要反映到 UI
      this.rtcConn.oniceconnectionstatechange = () => {
        const state = this.getConnectionState();
        if (state !== this.connectionState) {
          this.connectionState = state;
          this.onConnectionStateChange(state);
        }
      };

      this.rtcConn.onicecandidateerror = (event) => {
        // STUN/TURN 不可达时这里会频繁触发，只在 debug 级别记录
        console.debug(`[peer ${this.id}] ICE candidate error: ${event.errorCode} ${event.errorText}`);
      };
    }

    getConnectionState() {
      if (!this.rtcConn || this.closed) {
        return FGDX.connectionStates.DISCONNECTED;
      }
      if (this.rtcConn.connectionState) {
        return this.rtcConn.connectionState;
      }
      const ice = this.rtcConn.iceConnectionState;
      if (ice === 'connected' || ice === 'completed') {
        return this.rtcConn.signalingState === 'stable'
          ? FGDX.connectionStates.CONNECTED
          : FGDX.connectionStates.CONNECTING;
      }
      return ice || FGDX.connectionStates.DISCONNECTED;
    }

    close() {
      this.closed = true;
      this.receiver.abort();
      this.sender.cancel();
      this._textWaiters.splice(0).forEach((w) => w.cancel());
      this.pendingCandidates.length = 0;
      if (this.rtcConn) {
        this.rtcConn.onconnectionstatechange = null;
        this.rtcConn.oniceconnectionstatechange = null;
        this.rtcConn.onicecandidate = null;
        try { this.rtcConn.close(); } catch { /* ignore */ }
      }
      this.rtcConn = null;
      this.chatChannel = null;
      this.connectionState = FGDX.connectionStates.CLOSED;
      this.onConnectionStateChange(this.connectionState);
    }

    // ---------- 数据通道 ----------

    #bindDataChannel() {
      const channel = this.chatChannel;
      channel.binaryType = 'arraybuffer';
      channel.onmessage = (event) => this.#onChannelMessage(event.data);
      channel.onopen = () => {
        this.connectionState = this.getConnectionState();
        this.onConnectionStateChange(this.connectionState);
      };
      channel.onclose = () => {
        this.connectionState = FGDX.connectionStates.DISCONNECTED;
        this.onConnectionStateChange(this.connectionState);
      };
    }

    #onChannelMessage(data) {
      if (typeof data === 'string') {
        if (this.#resolveTextWaiter(data)) {
          return;
        }
        // 重传请求：交给发送端处理
        if (data.startsWith('{')) {
          try {
            const parsed = JSON.parse(data);
            if (parsed && parsed.type === FGDX.TRANSFER.RETRY_REQUEST && this._retryHandler) {
              this._retryHandler(parsed.chunks || []);
              return;
            }
          } catch { /* 普通文本 */ }
        }
        if (this.receiver.handleText(data)) {
          return;
        }
        this.onmessage(data);
        return;
      }
      this.receiver.handleBinary(data);
    }

    async sendText(text) {
      if (!this.chatChannel || this.chatChannel.readyState !== 'open') {
        throw new Error(`与 ${this.displayName} 的连接尚未建立`);
      }
      await this.chatChannel.send(text);
    }

    async #sendBinary(buffer) {
      await this.chatChannel.send(buffer);
    }

    /** 发送聊天消息：连不上时抛错让 UI 提示，而不是静默丢消息 */
    async sendMessage(text) {
      await this.sendText(text);
    }

    /**
     * @param {{name: string, size: number}} fileInfo
     * @param {Blob} file
     * @param {(sent: number, total: number) => void} [onProgress]
     */
    async sendFile(fileInfo, file, onProgress) {
      const previous = this.onFileProgress;
      if (onProgress) {
        this.onFileProgress = (sent, total) => onProgress(sent, total);
      }
      try {
        await this.sender.send({ name: fileInfo.name, size: file.size }, file);
      } finally {
        this.onFileProgress = previous;
      }
    }

    cancelTransfer() {
      this.sender.cancel();
    }

    /** 等缓冲区消化到阈值以下，避免 bufferedAmount 无界增长把内存打爆 */
    #waitForDrain() {
      const channel = this.chatChannel;
      if (!channel) return Promise.reject(new Error('连接已关闭'));
      if (channel.bufferedAmount <= MAX_BUFFERED) return Promise.resolve();
      return new Promise((resolve) => {
        const onLow = () => {
          channel.removeEventListener('bufferedamountlow', onLow);
          resolve();
        };
        channel.addEventListener('bufferedamountlow', onLow);
      });
    }

    #waitForText(predicate, timeoutMs, onTimeout) {
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            this.#removeWaiter(waiter);
            onTimeout?.();
          }, timeoutMs),
          cancel: () => {
            clearTimeout(waiter.timer);
            reject(new Error('连接已关闭'));
          },
        };
        this._textWaiters.push(waiter);
      });
    }

    #resolveTextWaiter(text) {
      for (let i = 0; i < this._textWaiters.length; i++) {
        const waiter = this._textWaiters[i];
        if (waiter.predicate(text)) {
          clearTimeout(waiter.timer);
          this._textWaiters.splice(i, 1);
          waiter.resolve();
          return true;
        }
      }
      return false;
    }

    #removeWaiter(waiter) {
      const index = this._textWaiters.indexOf(waiter);
      if (index !== -1) this._textWaiters.splice(index, 1);
    }
  }

  FGDX.Peer = Peer;
  FGDX.CHUNK_SIZE = CHUNK_SIZE;
})(window);
