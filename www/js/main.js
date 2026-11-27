/**
 * 页面入口。所有逻辑在 js/app.js 的 FGDX.App 里，
 * 这里只负责等 DOM 就绪后启动。
 */
(function () {
  'use strict';

  function boot() {
    const app = new window.FGDX.App();
    // 暴露到 window 方便在控制台排查问题（旧版本也是全局的，保持习惯）
    window.app = app;
    // 供 HTML 里内联 onclick 使用的少量入口
    window.submitRoomPassword = () => app.submitRoomPassword();
    window.saveNickname = () => app.saveNickname();
    app.start();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
