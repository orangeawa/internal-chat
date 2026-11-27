/**
 * 应用主控制器：把信令、P2P 连接、聊天/文件 UI 串起来。
 *
 * 房间与连接策略（这是「同一局域网有时发不了」的核心）：
 *
 *  1. 服务端会把同一房间内的用户列表推给每个人（1002）。
 *  2. 为了保证双方只建立一条连接，用 id 大小约定「谁发起」：
 *     id 较小的一方主动 createOffer，另一方等 offer。这样即使两人
 *     同时刷新页面（双方都收到「新人加入」），也不会互相发 offer 打架
 *     —— 旧实现里双方同时发起，后到的 offer 会把先到的连接冲掉，
 *     表现为连接一直停在 connecting / 发消息没反应。
 *  3. 对端掉线、信令断开重连后，重新评估一次需要建立哪些连接。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;
  const S = FGDX.SIGNAL;
  const utils = FGDX.utils;

  const STUN_COUNTRY_HINT = '如果双方不在同一个局域网，需要在 room_pwd.json 里配置 TURN 中继。';

  class App {
    constructor() {
      /** @type {Map<string, FGDX.Peer>} */
      this.peers = new Map();
      this.selfId = null;
      this.me = null;
      this.currentNickname = '';
      this.roomId = FGDX.roomIdFromPath();
      this.roomPassword = '';
      this.pendingOfferTargets = new Set();

      this.signaling = null;
      this.chatView = null;
      this.userListView = null;
      this.fileDialog = null;
    }

    // ---------- 启动 ----------

    start() {
      if (!window.RTCPeerConnection) {
        FGDX.ui.systemMessage('您的浏览器不支持 WebRTC，请使用 Chrome、Firefox、Safari 等现代浏览器访问。');
        return;
      }

      this.chatView = FGDX.createChatView({
        resolveName: (uid) => this.#resolveName(uid),
        selfId: () => this.selfId,
      });
      FGDX.chat = this.chatView;

      this.userListView = FGDX.createUserListView({
        getPeers: () => this.getPeers(),
        selfId: () => this.selfId,
      });

      this.fileDialog = FGDX.createFileSendDialog({
        getPeers: () => this.getPeers(),
        selfId: () => this.selfId,
        chat: this.chatView,
        onSend: (peers, file, onProgress) => this.#sendFileTo(peers, file, onProgress),
        onCancel: () => this.#cancelAllSends(),
      });

      FGDX.bindFileIntake({ onFile: (file) => this.promptSendFile(file) });
      this.#bindChatControls();
      this.#bindNicknameControls();
      this.#bindMobileControls();
      document.getElementById('submitPasswordBtn')?.addEventListener('click', () => this.submitRoomPassword());

      this.currentNickname = utils.readNicknameCookie();

      if (this.roomId) {
        this.#showPasswordModal();
      } else {
        this.#enterRoom();
      }
    }

    // ---------- 房间 / 信令 ----------

    #showPasswordModal() {
      document.querySelector('.left').style.display = 'none';
      document.querySelector('.right').style.display = 'none';
      FGDX.ui.show('passwordModal');
      const input = document.getElementById('roomPasswordInput');
      input.onkeydown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.submitRoomPassword();
        }
      };
      if (!FGDX.isMobile()) {
        setTimeout(() => input.focus(), 0);
      }
    }

    submitRoomPassword() {
      const input = document.getElementById('roomPasswordInput');
      const raw = input.value.trim();
      if (!raw) {
        FGDX.ui.toast('请输入密码', 'warn');
        return;
      }
      this.roomPassword = FGDX.md5(raw);
      FGDX.ui.hide('passwordModal');
      document.querySelector('.left').style.display = 'flex';
      document.querySelector('.right').style.display = 'block';
      this.#enterRoom();
    }

    #enterRoom() {
      this.signaling = new FGDX.SignalingClient({
        roomId: this.roomId,
        roomPassword: this.roomPassword,
        handlers: {
          onOpen: () => {
            if (this.everConnected) {
              FGDX.ui.toast('已重新连接', 'ok');
            }
            this.everConnected = true;
          },
          onClose: () => {
            if (this.signaling.closedByUser) return;
            FGDX.ui.toast('与服务器的连接中断，正在重连...', 'warn', 4000);
            this.#dropAllPeers();
          },
          onRegister: (data) => this.#onRegister(data),
          onRoomInfo: (list) => this.#onRoomInfo(list),
          onJoinedRoom: () => this.#connectMissingPeers(),
          onCandidate: (data) => this.#onCandidate(data),
          onOffer: (data) => this.#onOffer(data),
          onAnswer: (data) => this.#onAnswer(data),
          onNicknameUpdated: (data) => this.#onNicknameUpdated(data),
        },
      });

      if (this.roomId && this.roomPassword) {
        // 有房间号时，服务端校验失败会在 register 回调里把 roomId 置空
      }
      this.signaling.connect();
    }

    #onRegister(data) {
      this.selfId = data.id;
      if (this.roomId && data.roomId !== this.roomId) {
        this.roomId = '';
        FGDX.ui.systemMessage('房间密码错误，已切换到公共频道');
      }
      if (Array.isArray(data.turns) && data.turns.length > 0) {
        for (const turn of data.turns) {
          if (turn && turn.urls) FGDX.rtcConfiguration.iceServers.push(turn);
        }
      }
      this.#ensureSelfPeer();
      if (this.currentNickname) {
        this.#sendNickname(this.currentNickname);
      }
    }

    #onRoomInfo(list) {
      const seen = new Set();
      for (const info of list) {
        if (!info || info.id === this.selfId) continue;
        seen.add(info.id);
        const existing = this.peers.get(info.id);
        if (existing) {
          if (info.nickname) existing.nickname = info.nickname;
        } else {
          this.peers.set(info.id, this.#createPeer(info.id, info.nickname));
        }
      }
      // 列表里消失的人：断开并移除
      for (const [id, peer] of [...this.peers]) {
        if (id === this.selfId) continue;
        if (!seen.has(id)) {
          peer.close();
          this.peers.delete(id);
        }
      }
      this.#ensureSelfPeer();
      this.userListView.render();
      this.#connectMissingPeers();
    }

    #onCandidate(data) {
      const peer = this.peers.get(data.targetId);
      if (!peer) return;
      peer.addIceCandidate(data.candidate);
    }

    #onOffer(data) {
      // 我应该是发起方（id 更小）才对；如果对方也发来 offer，按对方为准重建
      let peer = this.peers.get(data.targetId);
      if (!peer) {
        peer = this.#createPeer(data.targetId, null);
        this.peers.set(data.targetId, peer);
      }
      this.pendingOfferTargets.add(data.targetId);
      peer.acceptOffer(data.offer?.sdp ?? data.offer)
        .then(() => {
          this.signaling.signalTo(peer.id, S.SEND_ANSWER, { targetAddr: peer.rtcConn.localDescription });
        })
        .catch((err) => {
          console.warn(`[app] 处理 offer 失败 (${peer.id}): ${err.message}`);
        })
        .finally(() => {
          this.pendingOfferTargets.delete(data.targetId);
          this.userListView.render();
        });
    }

    #onAnswer(data) {
      const peer = this.peers.get(data.targetId);
      if (!peer) return;
      peer.acceptAnswer(data.answer?.sdp ?? data.answer)
        .catch((err) => console.warn(`[app] 处理 answer 失败 (${peer.id}): ${err.message}`));
    }

    #onNicknameUpdated(data) {
      const peer = this.peers.get(data.id);
      if (peer) {
        peer.nickname = data.nickname;
        this.userListView.render();
      }
    }

    #ensureSelfPeer() {
      if (!this.selfId) return;
      let me = this.peers.get(this.selfId);
      if (!me) {
        me = new FGDX.Peer(this.selfId, {});
        me.isMe = true;
        this.peers.set(this.selfId, me);
      }
      me.nickname = this.currentNickname || me.nickname;
      this.me = me;
    }

    #createPeer(id, nickname) {
      const peer = new FGDX.Peer(id, {
        nickname,
        onicecandidate: (candidate) => {
          this.signaling?.signalTo(id, S.SEND_CANDIDATE, { candidate });
        },
        onmessage: (text) => this.chatView.addMessage(id, text),
        onFile: (file) => {
          this.chatView.addFile(id, file);
          FGDX.ui.toast(`收到来自 ${peer.displayName} 的文件：${file.name}`, 'ok', 4000);
        },
        onFileProgress: (received, total) => {
          if (total > 0 && received === total) {
            FGDX.ui.toast(`已收到来自 ${peer.displayName} 的文件`, 'ok');
          }
        },
        onConnectionStateChange: (state) => {
          this.userListView.render();
          if (state === 'failed') {
            // 主动方重试一次，被动方等待对方重新发起
            if (this.#shouldInitiate(id)) {
              this.#initiateConnection(peer, { force: true });
            }
          }
        },
      });
      peer.nickname = nickname || peer.nickname;
      return peer;
    }

    /** id 更小的一方负责发起连接，保证任意一对用户只有一条连接 */
    #shouldInitiate(peerId) {
      if (!this.selfId || !peerId) return false;
      return this.selfId < peerId;
    }

    #connectMissingPeers() {
      if (!this.signaling || !this.selfId) return;
      for (const peer of this.peers.values()) {
        if (peer.isMe) continue;
        if (peer.rtcConn) continue;
        if (this.pendingOfferTargets.has(peer.id)) continue;
        if (this.#shouldInitiate(peer.id)) {
          this.#initiateConnection(peer);
        }
      }
    }

    async #initiateConnection(peer, { force = false } = {}) {
      if (peer.rtcConn && !force) return;
      try {
        const offer = await peer.createOffer();
        if (!this.signaling.signalTo(peer.id, S.SEND_OFFER, { targetAddr: offer })) {
          return;
        }
        this.userListView.render();
      } catch (err) {
        console.warn(`[app] 建立连接失败 (${peer.id}): ${err.message}`);
      }
    }

    #dropAllPeers() {
      for (const [id, peer] of this.peers) {
        if (peer.isMe) continue;
        peer.close();
        this.peers.delete(id);
      }
      this.userListView.render();
    }

    // ---------- 聊天 ----------

    getPeers() {
      return [...this.peers.values()];
    }

    #resolveName(uid) {
      if (uid === 'system') return '系统';
      if (uid === this.selfId) return this.currentNickname || uid;
      const peer = this.peers.get(uid);
      return peer?.nickname || uid;
    }

    #bindChatControls() {
      const input = document.getElementById('messageInput');
      input.addEventListener('keydown', (event) => {
        // Enter 发送，Ctrl/Shift+Enter 换行（中文输入法组合中不触发）
        if (event.key === 'Enter' && !event.ctrlKey && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          this.sendMessage();
        }
      });
      document.querySelector('.send-btn')?.addEventListener('click', () => this.sendMessage());
    }

    async sendMessage() {
      const input = document.getElementById('messageInput');
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      this.chatView.addMessage(this.selfId, text);

      const targets = this.getPeers().filter((p) => !p.isMe && p.isConnected());
      if (targets.length === 0) {
        FGDX.ui.toast('当前没有已连接的用户，消息未发出', 'warn');
      }
      await Promise.all(targets.map((peer) => peer.sendMessage(text).catch((err) => {
        FGDX.ui.toast(`发送给 ${peer.displayName} 失败：${err.message}`, 'error');
      })));
    }

    // ---------- 文件 ----------

    async promptSendFile(file) {
      const others = this.getPeers().filter((p) => !p.isMe);
      if (others.length === 0) {
        FGDX.ui.toast('当前没有其他在线用户', 'warn');
        return;
      }
      const connected = others.filter((p) => p.isConnected());
      if (connected.length === 0) {
        FGDX.ui.toast('还没有用户建立连接，请稍候或检查网络', 'warn', 5000);
        return;
      }
      if (connected.length === 1) {
        await this.#sendFileTo(connected, file, () => {});
        return;
      }
      this.fileDialog.open(file);
    }

    async #sendFileTo(peers, file, onProgress) {
      const results = [];
      const fileInfo = { name: file.name, size: file.size };
      for (let i = 0; i < peers.length; i++) {
        const peer = peers[i];
        try {
          await peer.sendFile(fileInfo, file, (sent, total) => onProgress(i, sent, total));
          results.push({ peer, ok: true });
        } catch (err) {
          results.push({ peer, ok: false, error: this.#explainSendError(err) });
          if (err.message === 'cancelled') {
            for (let j = i + 1; j < peers.length; j++) {
              results.push({ peer: peers[j], ok: false, error: '已取消' });
            }
            break;
          }
        }
      }
      return results;
    }

    #explainSendError(err) {
      if (err.message === 'cancelled') return '已取消';
      if (/连接尚未建立|not open|Connection not open/i.test(err.message)) {
        return '未建立 P2P 连接';
      }
      if (/超时/.test(err.message)) return err.message;
      return err.message;
    }

    #cancelAllSends() {
      for (const peer of this.peers.values()) {
        peer.cancelTransfer();
      }
    }

    // ---------- 昵称 ----------

    #bindNicknameControls() {
      document.querySelector('.nickname-btn')?.addEventListener('click', () => this.#showNicknameModal());
      document.getElementById('nicknameInput')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.saveNickname();
        }
      });
      document.getElementById('saveNicknameBtn')?.addEventListener('click', () => this.saveNickname());
      document.getElementById('cancelNicknameBtn')?.addEventListener('click', () => FGDX.ui.hide('nicknameModal'));
    }

    #showNicknameModal() {
      const input = document.getElementById('nicknameInput');
      input.value = this.currentNickname;
      FGDX.ui.show('nicknameModal');
      setTimeout(() => input.focus(), 0);
    }

    saveNickname() {
      const input = document.getElementById('nicknameInput');
      const nickname = input.value.trim().slice(0, 10);
      if (nickname) {
        this.currentNickname = nickname;
        utils.writeNicknameCookie(nickname);
        const me = this.peers.get(this.selfId);
        if (me) me.nickname = nickname;
        this.#sendNickname(nickname);
        this.userListView.render();
      }
      FGDX.ui.hide('nicknameModal');
    }

    #sendNickname(nickname) {
      if (!this.signaling || !this.selfId) return;
      this.signaling.send({
        uid: this.selfId,
        targetId: this.selfId,
        type: S.SEND_NICKNAME,
        data: { nickname },
      });
    }

    // ---------- 移动端 ----------

    #bindMobileControls() {
      const toggle = () => document.body.classList.toggle('show-users');
      document.querySelector('.toggle-users-btn')?.addEventListener('click', toggle);
      document.querySelector('.mobile-overlay')?.addEventListener('click', toggle);
      if (window.innerWidth <= 768) {
        document.body.classList.remove('show-users');
      }
    }
  }

  FGDX.App = App;
  FGDX.STUN_COUNTRY_HINT = STUN_COUNTRY_HINT;
})(window);
