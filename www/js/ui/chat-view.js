/**
 * 聊天记录渲染。
 *
 * 历史消息在内存里保留最近 MAX_MESSAGES 条，切换/重绘时不会丢；
 * 所有用户输入都经过转义，只额外放行 http(s) 链接。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;
  const utils = FGDX.utils;
  const MAX_MESSAGES = 500;

  const COPY_ICON = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" fill="currentColor"></path></svg>';
  const DONE_ICON = '<svg viewBox="0 0 1024 1024" width="20" height="21"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5L207 474a32 32 0 0 0-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z" fill="currentColor"></path></svg>';

  /**
   * @param {{resolveName: (uid: string) => string, selfId: () => string}} deps
   */
  function createChatView(deps) {
    const chatBox = document.querySelector('.chat-wrapper');
    /** @type {Array<object>} */
    let history = [];

    function renderLinkified(escapedText) {
      return escapedText.replace(/(https?:\/\/[^\s<>"']+)/g, (url) => {
        // 已转义文本里的 &amp; 要还原成 & 才能被正确打开
        const href = url.replace(/&amp;/g, '&');
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
      });
    }

    function appendMessage(entry) {
      const item = document.createElement('div');
      item.className = 'chat-item';
      const isSystem = entry.uid === 'system';
      const isMine = !isSystem && entry.uid === deps.selfId();
      const displayName = isSystem ? '系统' : deps.resolveName(entry.uid);

      const label = `${isMine ? '（我）' : ''}${utils.escapeHtml(displayName)} :`;
      const content = isSystem
        ? `<pre>${utils.escapeHtml(entry.text)}</pre>`
        : `<pre>${renderLinkified(utils.escapeHtml(entry.text))}</pre>`;

      item.innerHTML = `
        <div class="chat-item_user ${isSystem ? 'system' : ''}">${label}</div>
        <div class="chat-item_content">${content}</div>
      `;

      if (!isSystem) {
        const button = document.createElement('button');
        button.className = 'copy-btn';
        button.title = '复制';
        button.innerHTML = COPY_ICON;
        button.onclick = () => copyText(entry.text, button);
        item.querySelector('.chat-item_content').appendChild(button);
      }

      chatBox.appendChild(item);
      chatBox.scrollTop = chatBox.scrollHeight;
      return item;
    }

    function push(entry) {
      history.push(entry);
      if (history.length > MAX_MESSAGES) {
        history = history.slice(-MAX_MESSAGES);
      }
      return appendMessage(entry);
    }

    async function copyText(text, button) {
      const done = () => {
        button.innerHTML = DONE_ICON;
        setTimeout(() => { button.innerHTML = COPY_ICON; }, 1000);
      };
      try {
        await navigator.clipboard.writeText(text);
        done();
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try { document.execCommand('copy'); } catch { /* ignore */ }
        document.body.removeChild(textarea);
        done();
      }
    }

    /** 文件条目（图片直接预览） */
    function appendFile(uid, file) {
      const item = document.createElement('div');
      item.className = 'chat-item';
      const displayName = utils.escapeHtml(deps.resolveName(uid));
      const isMine = uid === deps.selfId();
      const safeName = utils.escapeHtml(file.name);
      const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file.name);

      let content;
      if (isImage) {
        content = `
          <div class="image-preview">
            <img src="${file.url}" alt="${safeName}" />
          </div>
          <a href="${file.url}" download="${safeName}" class="download-btn" title="下载">
            <svg viewBox="0 0 24 24" width="20" height="20"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>
          </a>
        `;
      } else {
        content = `<a class="file" href="${file.url}" download="${safeName}">[文件] ${safeName} <span class="file-size">${utils.formatSize(file.size)}</span></a>`;
      }

      item.innerHTML = `
        <div class="chat-item_user">${isMine ? '（我）' : ''}${displayName} :</div>
        <div class="chat-item_content">${content}</div>
      `;

      if (isImage) {
        const img = item.querySelector('img');
        img.onclick = () => openImagePreview(file.url, file.name);
        img.onload = () => { chatBox.scrollTop = chatBox.scrollHeight; };
      }

      chatBox.appendChild(item);
      if (!isImage) chatBox.scrollTop = chatBox.scrollHeight;
    }

    function openImagePreview(url, name) {
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(`
        <html><head><title>${utils.escapeHtml(name)}</title>
        <style>
          body{margin:0;padding:20px;background:#1a1a1a;display:flex;justify-content:center;align-items:center;min-height:100vh}
          img{max-width:100%;max-height:90vh;object-fit:contain}
        </style></head>
        <body><img src="${url}" alt="${utils.escapeHtml(name)}" /></body></html>
      `);
      win.document.close();
    }

    return {
      addMessage(uid, text) {
        return push({ uid, text, kind: 'text', at: Date.now() });
      },
      addSystem(text) {
        return push({ uid: 'system', text, kind: 'system', at: Date.now() });
      },
      addFile(uid, file) {
        // 文件对象带 blob URL，只存元信息，避免刷新/重绘时重复占内存
        history.push({ uid, text: `[文件] ${file.name}`, kind: 'file', at: Date.now() });
        if (history.length > MAX_MESSAGES) history = history.slice(-MAX_MESSAGES);
        appendFile(uid, file);
      },
      getHistory() { return history; },
    };
  }

  FGDX.createChatView = createChatView;
})(window);
