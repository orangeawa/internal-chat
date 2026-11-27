'use strict';

/**
 * IP 归属判定：决定一个连接落到哪个「房间」。
 *
 * 无房间号时：
 *  - 内网 / 回环地址统一进 'internal' 房间（同一局域网的设备互相可见）
 *  - 公网地址按 IP 自身的 /24 分组（比原来的「每个 IP 一个房间」更合理：
 *    同一个公网出口后面的用户可以互相发现）
 *
 * 注意：这里的 IP 来自 X-Forwarded-For 或 TCP 连接，可能带端口、可能是域名。
 * 老版本直接 startsWith 判断，导致 `[::ffff:192.168.1.5]:12345` 之类的
 * 形式全部落到「公网」分支，局域网用户互相看不到 —— 这属于「有时能发、
 * 有时不能发」的诱因之一。
 */

/** 去掉 IPv6 映射前缀、方括号与端口 */
function normalizeIp(ip) {
  if (typeof ip !== 'string') {
    return '';
  }
  let value = ip.trim();
  if (!value) {
    return '';
  }
  // X-Forwarded-For 可能是 "a, b, c"，取第一个（最初的客户端）
  if (value.includes(',')) {
    value = value.split(',')[0].trim();
  }
  // [::ffff:192.168.1.5]:12345 / [2001:db8::1]
  const bracket = value.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) {
    value = bracket[1];
  }
  // ::ffff:192.168.1.5
  value = value.replace(/^::ffff:/i, '');
  // 2001:db8::1:8080 这种无法可靠拆分，交给调用方保证
  return value.toLowerCase();
}

function ipv4Parts(ip) {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    return null;
  }
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) {
    return null;
  }
  return parts;
}

function isLoopback(ip) {
  const v4 = ipv4Parts(ip);
  if (v4) {
    return v4[0] === 127;
  }
  return ip === '::1' || ip === '0:0:0:0:0:0:0:1';
}

function isPrivateV4(parts) {
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // 运营商级 NAT / 容器网络也常见，归入内网方便互传
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateV6(ip) {
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 ULA
  if (ip.startsWith('fe80')) return true; // 链路本地
  return false;
}

/** 是不是内网 / 回环地址 */
function isInternalIp(rawIp) {
  const ip = normalizeIp(rawIp);
  if (!ip) {
    return false;
  }
  const v4 = ipv4Parts(ip);
  if (v4) {
    return isLoopback(ip) || isPrivateV4(v4);
  }
  return isPrivateV6(ip) || isLoopback(ip);
}

/**
 * 公网地址的归组键。
 *
 * IPv4 保持「每个公网 IP 一个房间」：同一 NAT 后面的用户本来就共享出口 IP。
 * IPv6 取 /64 前缀：同一个局域网（同一条 SLAAC 前缀）下的设备往往会拿到
 * 不同的公网 IPv6，如果按完整地址分组，同一局域网的两个人就会被分到不同
 * 房间、互相看不见 —— 这是「有时能发、有时不能发」的常见诱因。
 */
function publicGroupKey(ip) {
  const v4 = ipv4Parts(ip);
  if (v4) {
    return v4.join('.');
  }
  const groups = ip.split(':');
  // 展开 :: 简写，避免 2001:db8:: 与 2001:db8:0:0:: 被分到不同组
  const expanded = [];
  const emptyAt = groups.indexOf('');
  if (emptyAt !== -1) {
    const head = groups.slice(0, emptyAt).filter(Boolean);
    const tail = groups.slice(groups.lastIndexOf('') + 1).filter(Boolean);
    while (head.length + tail.length < 8) head.push('0');
    expanded.push(...head, ...tail);
  } else {
    expanded.push(...groups);
  }
  return expanded.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/**
 * 计算房间 key。
 * @param {string} ip 客户端 IP（可能未规范化）
 * @param {string|null} roomId 显式房间号（来自 URL /ws/:roomId/:pwd）
 * @returns {string}
 */
function getRoomKey(ip, roomId) {
  if (roomId) {
    return `room:${roomId}`;
  }
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return 'internal';
  }
  if (isInternalIp(normalized)) {
    return 'internal';
  }
  return `public:${publicGroupKey(normalized)}`;
}

module.exports = { getRoomKey, isInternalIp, normalizeIp, publicGroupKey };
