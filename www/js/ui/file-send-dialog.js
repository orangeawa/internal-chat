/**
 * 文件发送对话框：选择接收者、显示进度、取消。
 *
 * 相比旧实现修掉的问题：
 *  - 多选时某个目标发失败，旧代码 break 跳出整个循环，后面的人一个字节都
 *    收不到，而且没有任何提示；现在逐个发送、逐个报告结果。
 *  - 只有一个接收者时旧代码把「取消」按钮隐藏，出错后无法取消。
 *  - 进度条/文字/按钮的显隐逻辑原本散落在两个函数里且互相覆盖，
 *    现在统一由 setMode() 管理。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;
  const ui = FGDX.ui;
  const utils = FGDX.utils;

  const MODAL_ID = 'userSelectModal';

  /**
   * @param {{getPeers: () => Array, selfId: () => string,
   *          chat: { addFile: (uid: string, file: object) => void },
   *          onSend: (peers: Array, file: File, onProgress: (i: number, sent: number, total: number) => void) => Promise<Array>,
   *          onCancel: () => void}} deps
   */
  function createFileSendDialog(deps) {
    const modal = document.getElementById(MODAL_ID);
    const listEl = document.getElementById('userSelectList');
    const progressEl = modal.querySelector('.progress-container');
    const progressBar = modal.querySelector('.progress-bar-inner');
    const progressText = modal.querySelector('.progress-text');
    const cancelBtn = document.getElementById('fileSendCancelBtn');
    const sendBtn = document.getElementById('fileSendConfirmBtn');

    let pendingFile = null;
    let sending = false;
    let startedAt = Date.now();

    function setMode(mode) {
      // mode: 'select' | 'sending'
      const isSending = mode === 'sending';
      listEl.style.display = isSending ? 'none' : 'block';
      progressEl.style.display = isSending ? 'block' : 'none';
      sendBtn.style.display = isSending ? 'none' : 'inline-block';
      sendBtn.disabled = false;
      sendBtn.textContent = '发送';
      cancelBtn.textContent = isSending ? '取消传输' : '取消';
      if (!isSending) {
        progressBar.style.width = '0%';
        progressText.textContent = '正在发送...';
      }
    }

    function renderUserList() {
      listEl.innerHTML = '';
      const peers = deps.getPeers().filter((p) => !p.isMe);
      if (peers.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'user-select-empty';
        empty.textContent = '当前没有其他在线用户';
        listEl.appendChild(empty);
        return;
      }
      for (const peer of peers) {
        const item = document.createElement('div');
        item.className = 'user-select-item';
        item.innerHTML = `
          <label>
            <input type="checkbox" value="${utils.escapeHtml(peer.id)}" checked>
            <span>${utils.escapeHtml(peer.displayName)}</span>
            <em class="peer-hint ${peer.isConnected() ? 'ok' : 'warn'}">${peer.isConnected() ? '已连接' : '未连接'}</em>
          </label>
        `;
        item.addEventListener('click', (e) => {
          const checkbox = item.querySelector('input[type="checkbox"]');
          if (e.target === checkbox) return;
          checkbox.checked = !checkbox.checked;
          e.preventDefault();
        });
        listEl.appendChild(item);
      }
    }

    function open(file) {
      pendingFile = file;
      startedAt = Date.now();
      renderUserList();
      setMode('select');
      ui.show(MODAL_ID);
    }

    function close() {
      if (sending) return; // 传输中不允许直接关闭，必须点取消
      pendingFile = null;
      ui.hide(MODAL_ID);
    }

    async function confirm() {
      if (!pendingFile || sending) return;
      const selectedIds = Array.from(listEl.querySelectorAll('input[type="checkbox"]:checked'))
        .map((cb) => cb.value);
      const peers = deps.getPeers().filter((p) => selectedIds.includes(p.id));
      if (peers.length === 0) {
        ui.toast('请至少选择一个接收者', 'warn');
        return;
      }

      const file = pendingFile;
      sending = true;
      setMode('sending');

      try {
        const results = await deps.onSend(peers, file, (index, sent, total) => {
          const perTarget = total > 0 ? (sent / total) * 100 : 0;
          const overall = ((index + perTarget / 100) / peers.length) * 100;
          progressBar.style.width = `${overall.toFixed(1)}%`;
          const speed = utils.formatSpeed(sent / Math.max((Date.now() - startedAt) / 1000, 0.001));
          progressText.textContent =
            peers.length === 1
              ? `正在发送给 ${peers[0].displayName}... ${speed}`
              : `正在发送给 ${peers[index].displayName}... (${index + 1}/${peers.length}) ${speed}`;
        });
        const ok = results.filter((r) => r.ok);
        const failed = results.filter((r) => !r.ok);
        for (const r of ok) {
          deps.chat.addFile(deps.selfId(), {
            name: file.name,
            size: file.size,
            url: URL.createObjectURL(file),
          });
        }
        if (failed.length > 0) {
          const names = failed.map((r) => `${r.peer.displayName}（${r.error}）`).join('、');
          ui.toast(`发送失败：${names}`, 'error', 6000);
        }
        if (ok.length > 0 && failed.length === 0) {
          ui.toast(`已发送给 ${ok.map((r) => r.peer.displayName).join('、')}`, 'ok');
        }
      } catch (err) {
        ui.toast(`发送失败：${err.message}`, 'error', 6000);
      } finally {
        sending = false;
        pendingFile = null;
        startedAt = Date.now();
        ui.hide(MODAL_ID);
        setMode('select');
      }
    }

    function cancel() {
      if (sending) {
        deps.onCancel();
        progressText.textContent = '正在取消...';
        return;
      }
      close();
    }

    sendBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', cancel);

    return { open, close };
  }

  FGDX.createFileSendDialog = createFileSendDialog;
})(window);
