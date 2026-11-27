/**
 * 文件传输协议层（接收端 + 发送端）。
 *
 * 设计说明：
 *  - 控制消息是文本帧（##FILE_S## / ##CHUNK_INFO## / ...），数据是二进制帧。
 *  - 每个数据块前先发一条 CHUNK_INFO 说明 index/size，接收端据此落位，
 *    这样即使 DataChannel 的顺序性被破坏（或将来改成 unordered）也能重组。
 *  - 缺失块在收到 END 时统一请求重传，最多 MAX_ROUNDS 轮。
 *
 * 相比旧实现修掉的问题：
 *  - 旧实现把「兼容旧格式化消息」的分支扔进了这个协议里，导致任何
 *    JSON 形式的聊天消息都被当控制帧解析；
 *  - 旧接收端在 END 时 size 不匹配但「没有缺失块」的情况下会卡死不动；
 *  - 旧发送端在取消传输后既没有拒绝也没有 resolve，调用方会一直挂着。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;
  const T = FGDX.TRANSFER;
  const CHUNK_SIZE = FGDX.FILE_CHUNK_SIZE;

  const MAX_RETRY_ROUNDS = 3;
  const TRANSFER_IDLE_TIMEOUT_MS = 30 * 1000;
  const START_ACK_TIMEOUT_MS = 5 * 1000;
  const FINAL_ACK_TIMEOUT_MS = 30 * 1000;

  /** 一个文件接收过程的状态 */
  class FileReceiver {
    /**
     * @param {{ onFile: (file: {url: string, name: string, size: number}) => void,
     *           sendText: (text: string) => Promise<void>,
     *           onProgress?: (received: number, total: number) => void }} hooks
     */
    constructor(hooks) {
      this.hooks = hooks;
      this.active = false;
      this.fileInfo = null;
      this.expectedSize = 0;
      this.chunkSize = CHUNK_SIZE;
      this.totalChunks = 0;
      this.chunks = null;
      this.receivedSize = 0;
      this.currentChunkInfo = null;
      this.missing = new Set();
      this.retryRound = 0;
      this.idleTimer = null;
    }

    /** 是否正在收文件（用于区分控制帧和聊天文本） */
    get busy() {
      return this.active;
    }

    /** @returns {boolean} 是否消费了这条文本消息 */
    handleText(text) {
      if (text.startsWith(T.START)) {
        this.#onStart(text.slice(T.START.length));
        return true;
      }
      if (text === T.END) {
        this.#onEnd();
        return true;
      }
      if (text === T.START_ACK || text === T.RECEIVED || text === T.PROGRESS_ACK) {
        return true; // 由发送端处理
      }
      if (!this.active) {
        return false;
      }
      if (text.startsWith('{')) {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { return false; }
        if (parsed && parsed.type === T.CHUNK_INFO) {
          this.currentChunkInfo = parsed.data;
          return true;
        }
        if (parsed && parsed.type === T.RETRY_REQUEST) {
          return true; // 接收端不该收到重传请求
        }
      }
      return false;
    }

    /** @returns {boolean} 是否消费了这条二进制消息 */
    handleBinary(data) {
      if (!this.active || !this.currentChunkInfo) {
        return false;
      }
      this.#touchTimer();

      const { index, size } = this.currentChunkInfo;
      const buffer = data instanceof ArrayBuffer ? data : data.buffer;
      if (!buffer) {
        return true;
      }
      if (buffer.byteLength !== size || index >= this.totalChunks || this.chunks[index]) {
        // 大小不符或重复块：标记缺失，等 END 时统一补
        this.missing.add(index);
        return true;
      }
      this.chunks[index] = buffer;
      this.receivedSize += buffer.byteLength;
      this.missing.delete(index);
      this.hooks.onProgress?.(this.receivedSize, this.expectedSize);
      return true;
    }

    abort() {
      this.#reset();
    }

    #onStart(json) {
      let info;
      try {
        info = JSON.parse(json);
      } catch {
        return;
      }
      if (!info || typeof info.name !== 'string' || !Number.isFinite(info.size) || info.size < 0) {
        return;
      }
      return Promise.resolve(this.hooks.sendText(T.START_ACK)).then(() => {
        this.#reset();
        this.active = true;
        this.fileInfo = info;
        this.expectedSize = info.size;
        this.totalChunks = Math.ceil(info.size / this.chunkSize) || 0;
        this.chunks = new Array(this.totalChunks).fill(null);
        this.receivedSize = 0;
        this.missing.clear();
        this.retryRound = 0;
        this.#touchTimer();
      }).catch(() => {});
    }

    async #onEnd() {
      if (!this.active) {
        return;
      }
      const missing = [];
      for (let i = 0; i < this.totalChunks; i++) {
        if (!this.chunks[i]) missing.push(i);
      }

      if (missing.length > 0) {
        if (this.retryRound < MAX_RETRY_ROUNDS) {
          this.retryRound++;
          this.missing = new Set(missing);
          await this.hooks.sendText(JSON.stringify({ type: T.RETRY_REQUEST, chunks: missing })).catch(() => {});
          this.#touchTimer();
          return;
        }
        // 重传耗尽仍然缺块：显式失败，别让用户以为卡在 99%
        console.warn(`[transfer] 文件传输失败，缺失 ${missing.length} 个分片`);
        this.#reset();
        return;
      }

      if (this.receivedSize !== this.expectedSize) {
        console.warn(`[transfer] 文件大小不一致: 期望 ${this.expectedSize}, 实际 ${this.receivedSize}`);
        this.#reset();
        return;
      }

      const blob = new Blob(this.chunks);
      const url = URL.createObjectURL(blob);
      const file = { url, name: this.fileInfo.name, size: this.receivedSize, mime: blob.type };
      this.#reset();
      this.hooks.onFile(file);
      await this.hooks.sendText(T.RECEIVED).catch(() => {});
    }

    #touchTimer() {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.active) {
          console.warn('[transfer] 接收超时，已放弃本次传输');
        }
        this.#reset();
      }, TRANSFER_IDLE_TIMEOUT_MS);
    }

    #reset() {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.active = false;
      this.chunks = null;
      this.currentChunkInfo = null;
      this.receivedSize = 0;
      this.expectedSize = 0;
      this.totalChunks = 0;
      this.fileInfo = null;
      this.missing.clear();
      this.retryRound = 0;
    }
  }

  /** 一个文件发送过程 */
  class FileSender {
    /**
     * @param {{ sendText: (t: string) => Promise<void>,
     *           sendBinary: (b: ArrayBuffer) => Promise<void>,
     *           waitForText: (predicate: (t: string) => boolean, timeoutMs: number, onTimeout: () => void) => Promise<void>,
     *           waitForDrain: () => Promise<void>,
     *           retryRequestHandler: { set: (fn: ((chunks: number[]) => void) | null) => void },
     *           onProgress?: (sent: number, total: number) => void }} hooks
     */
    constructor(hooks) {
      this.hooks = hooks;
      this.cancelled = false;
      this.cancelSignal = null;
    }

    cancel() {
      this.cancelled = true;
      this.cancelSignal?.();
    }

    /**
     * @param {{name: string, size: number}} fileInfo
     * @param {Blob} file
     */
    async send(fileInfo, file) {
      this.cancelled = false;
      const chunkSize = CHUNK_SIZE;
      const totalChunks = Math.ceil(file.size / chunkSize) || 0;

      const sendChunk = async (index) => {
        if (this.cancelled) throw new Error('cancelled');
        const start = index * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const buffer = await file.slice(start, end).arrayBuffer();
        await this.hooks.sendText(JSON.stringify({
          type: T.CHUNK_INFO,
          data: { index, total: totalChunks, size: buffer.byteLength },
        }));
        await this.hooks.waitForDrain();
        await this.hooks.sendBinary(buffer);
      };

      const resendSafely = async (index) => {
        try {
          await sendChunk(index);
        } catch {
          // 取消或断线时忽略；对端会在下一轮重传请求里再要
        }
      };

      try {
        // 1) 文件头，等对端 ACK
        await this.hooks.sendText(T.START + JSON.stringify({ name: fileInfo.name, size: file.size }));
        await this.#waitWithCancel((resolve, reject) =>
          this.hooks.waitForText((t) => t === T.START_ACK, START_ACK_TIMEOUT_MS,
            () => reject(new Error('对端没有响应（连接可能已断开）'))).then(resolve, reject));

        // 2) 对端缺块时会主动请求重传
        this.hooks.retryRequestHandler.set(async (chunks) => {
          for (const index of chunks) {
            if (this.cancelled) return;
            await resendSafely(index);
            await FGDX.utils.sleep(20);
          }
          if (!this.cancelled) {
            await this.hooks.sendText(T.END).catch(() => {});
          }
        });

        // 3) 数据块
        let sent = 0;
        for (let index = 0; index < totalChunks; index++) {
          if (this.cancelled) throw new Error('cancelled');
          await sendChunk(index);
          sent += Math.min(chunkSize, file.size - index * chunkSize);
          this.hooks.onProgress?.(sent, file.size);
        }

        // 4) 结束标记，等对端完整性确认
        await this.hooks.sendText(T.END);
        await this.#waitWithCancel((resolve, reject) =>
          this.hooks.waitForText((t) => t === T.RECEIVED, FINAL_ACK_TIMEOUT_MS,
            () => reject(new Error('接收方确认超时'))).then(resolve, reject));
      } finally {
        this.hooks.retryRequestHandler.set(null);
      }
    }

    /**
     * 包一层取消信号：cancel() 时让正在等待的传输立刻 reject，
     * 不再出现「点了取消但界面一直卡在发送中」。
     * @param {(resolve: Function, reject: Function) => Promise<void>} executor 必须返回 Promise
     */
    #waitWithCancel(executor) {
      if (this.cancelled) {
        return Promise.reject(new Error('cancelled'));
      }
      return new Promise((resolve, reject) => {
        this.cancelSignal = () => reject(new Error('cancelled'));
        const task = executor(resolve, reject);
        // executor 里已经把错误转给 reject 了，这里只需要清理取消信号
        Promise.resolve(task)
          .catch(() => {})
          .then(() => { this.cancelSignal = null; });
      });
    }
  }

  FGDX.transfer = { FileReceiver, FileSender, CHUNK_SIZE };
})(window);
