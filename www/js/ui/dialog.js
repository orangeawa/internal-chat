/**
 * 通用 UI 组件：模态框开关、toast、系统提示。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;

  const toastContainer = () => {
    let el = document.getElementById('toastContainer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toastContainer';
      el.className = 'toast-container';
      document.body.appendChild(el);
    }
    return el;
  };

  const ui = {
    show(id) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'block';
    },

    hide(id) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    },

    isVisible(id) {
      const el = document.getElementById(id);
      return !!el && el.style.display !== 'none';
    },

    /** 轻提示，不打断操作 */
    toast(message, type = 'info', duration = 3000) {
      const el = document.createElement('div');
      el.className = `toast toast-${type}`;
      el.textContent = message;
      toastContainer().appendChild(el);
      setTimeout(() => el.classList.add('toast-out'), Math.max(duration - 300, 0));
      setTimeout(() => el.remove(), duration);
    },

    /** 聊天区里的系统消息 */
    systemMessage(message) {
      const chatBox = document.querySelector('.chat-wrapper');
      if (!chatBox) return;
      const item = document.createElement('div');
      item.className = 'chat-item';
      item.innerHTML = `
        <div class="chat-item_user system">系统 :</div>
        <div class="chat-item_content system-content">
          <pre>${FGDX.utils.escapeHtml(message)}</pre>
        </div>
      `;
      chatBox.appendChild(item);
      chatBox.scrollTop = chatBox.scrollHeight;
    },

    scrollChatToBottom() {
      const chatBox = document.querySelector('.chat-wrapper');
      if (chatBox) chatBox.scrollTop = chatBox.scrollHeight;
    },
  };

  FGDX.ui = ui;
})(window);
