/**
 * 右侧在线用户列表 / 移动端用户抽屉。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;

  const CONNECTED_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>';
  const DISCONNECTED_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 7h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1 0 1.43-.98 2.63-2.31 2.98l1.46 1.46C20.88 15.61 22 13.95 22 12c0-2.76-2.24-5-5-5zm-1 4h-2.19l2 2H16zM2 4.27l3.11 3.11C3.29 8.12 2 9.91 2 12c0 2.76 2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1 0-1.59 1.21-2.9 2.76-3.07L8.73 11H8v2h2.73L13 15.27V17h1.73l4.01 4L20 19.74 3.27 3 2 4.27z"/></svg>';

  /**
   * @param {{getPeers: () => Array, selfId: () => string, t: (key: string) => string}} deps
   */
  function createUserListView(deps) {
    const container = document.querySelector('#users');

    function render() {
      const peers = deps.getPeers();
      container.innerHTML = peers.map((peer) => {
        const connected = peer.isMe || peer.isConnected();
        const statusClass = connected ? 'connected' : 'disconnected';
        const icon = connected ? CONNECTED_ICON : DISCONNECTED_ICON;
        const name = FGDX.utils.escapeHtml(peer.displayName);
        const mine = peer.isMe ? '（我）' : '';
        const title = connected ? '已连接' : '未连接（尝试中）';
        return `
          <li title="${title}">
            <span class="connection-status ${statusClass}">${icon}</span>
            ${name}${mine}
          </li>
        `;
      }).join('');
    }

    return { render, container };
  }

  FGDX.createUserListView = createUserListView;
})(window);
