/**
 * 拖拽文件到窗口 + 点击「发送文件」按钮 + 粘贴图片。
 * 三种入口统一走 onFile 回调。
 */
(function (global) {
  'use strict';

  const FGDX = global.FGDX;

  /**
   * @param {{ onFile: (file: File) => void }} handlers
   */
  function bindFileIntake(handlers) {
    const target = document.body;
    let dragDepth = 0;

    const showTip = () => target.classList.add('dragover');
    const hideTip = () => target.classList.remove('dragover');

    target.addEventListener('dragenter', (event) => {
      event.preventDefault();
      dragDepth++;
      if (event.dataTransfer?.types?.includes('Files')) showTip();
    });

    target.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });

    target.addEventListener('dragleave', (event) => {
      event.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideTip();
    });

    target.addEventListener('drop', (event) => {
      event.preventDefault();
      dragDepth = 0;
      hideTip();
      const files = event.dataTransfer?.files;
      if (files && files.length > 0) handlers.onFile(files[0]);
    });

    document.querySelector('.file-btn')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.onchange = () => {
        if (input.files && input.files.length > 0) handlers.onFile(input.files[0]);
      };
      input.click();
    });

    document.addEventListener('paste', (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          event.preventDefault();
          const file = item.getAsFile();
          if (!file) return;
          const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
          handlers.onFile(new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type }));
          return;
        }
      }
    });
  }

  FGDX.bindFileIntake = bindFileIntake;
})(window);
