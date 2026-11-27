'use strict';

/**
 * 统一日志：给 console.log / console.error 打上时间戳。
 *
 * 之所以直接改写 console，是为了让依赖库（ws 等）输出的日志也带时间戳。
 * 只在入口调用一次，模块内部统一走 ./logger。
 */

const pad = (num, len = 2) => String(num).padStart(len, '0');

function timestamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

let installed = false;

function installTimestampedConsole() {
  if (installed) {
    return;
  }
  installed = true;

  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.log = (...args) => originalLog(`[${timestamp()}]`, ...args);
  console.error = (...args) => originalError(`[${timestamp()}]`, ...args);
  console.warn = (...args) => originalWarn(`[${timestamp()}]`, ...args);
}

const logger = {
  log: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
};

module.exports = { installTimestampedConsole, logger, timestamp };
