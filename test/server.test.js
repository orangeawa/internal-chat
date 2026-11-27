'use strict';
// 服务端回归测试：node --test test/server.test.js
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextPort = 8300;
function port() { return nextPort++; }

async function startServer(p) {
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), String(p)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  await sleep(600);
  return { child, log: () => log, stop: () => child.kill('SIGKILL') };
}

function connect(p, { ip, cookie = '' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (ip) headers['X-Forwarded-For'] = ip;
    if (cookie) headers.Cookie = cookie;
    const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, { headers });
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    ws.on('error', reject);
    ws.on('open', () => setTimeout(() => resolve({ ws, msgs }), 250));
  });
}

const peers = (c) => {
  const last = [...c.msgs].reverse().find((m) => m.type === '1002');
  return last ? last.data.map((u) => u.id) : [];
};
const myId = (c) => c.msgs.find((m) => m.type === '1001').data.id;
const reg = (c) => c.msgs.find((m) => m.type === '1001');

test('服务器在收到非法 JSON 后仍然存活', async () => {
  const p = port();
  const s = await startServer(p);
  const c = await connect(p, { ip: '10.0.0.1' });
  c.ws.send('this is not json');
  c.ws.send('null');
  c.ws.send('{"type":9001}');
  await sleep(500);
  assert.strictEqual(s.child.exitCode, null, `服务器退出了:\n${s.log()}`);
  const c2 = await connect(p, { ip: '10.0.0.2' });
  assert.ok(myId(c2));
  c.ws.close(); c2.ws.close(); s.stop();
});

test('畸形 URL 不会让进程退出', async () => {
  const p = port();
  const s = await startServer(p);
  for (const u of ['/%zz', '/%', '/%E0%A4%A', '/..%2f..%2fetc/passwd']) {
    await fetch(`http://127.0.0.1:${p}${u}`).catch(() => {});
  }
  await sleep(300);
  assert.strictEqual(s.child.exitCode, null, `服务器退出了:\n${s.log()}`);
  const res = await fetch(`http://127.0.0.1:${p}/`);
  assert.strictEqual(res.status, 200);
  s.stop();
});

test('目录穿越读不到项目根目录文件', async () => {
  const p = port();
  const s = await startServer(p);
  for (const u of ['/../package.json', '/../../etc/passwd', '/..%2Fpackage.json', '/%2e%2e/package.json']) {
    const res = await fetch(`http://127.0.0.1:${p}${u}`, { redirect: 'manual' });
    const body = await res.text();
    assert.ok(!body.includes('internal-chat'), `${u} 泄漏了 package.json`);
    assert.ok(!body.includes('root:'), `${u} 泄漏了 /etc/passwd`);
  }
  s.stop();
});

test('静态资源带正确 Content-Type,未知 JS 返回 404 而不是 HTML', async () => {
  const p = port();
  const s = await startServer(p);
  const css = await fetch(`http://127.0.0.1:${p}/style.css`);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const js = await fetch(`http://127.0.0.1:${p}/nope.js`);
  assert.strictEqual(js.status, 404);
  const html = await fetch(`http://127.0.0.1:${p}/some/spa/route`);
  assert.strictEqual(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  s.stop();
});

test('同一局域网的不同 IPv4 在同一房间', async () => {
  const p = port();
  const s = await startServer(p);
  const a = await connect(p, { ip: '192.168.1.5' });
  const b = await connect(p, { ip: '192.168.1.9' });
  assert.deepStrictEqual(peers(a).sort(), peers(b).sort());
  assert.strictEqual(peers(a).length, 2);
  a.ws.close(); b.ws.close(); s.stop();
});

test('IPv6 映射地址 / 带端口 / XFF 列表都识别为内网', async () => {
  const p = port();
  const s = await startServer(p);
  const a = await connect(p, { ip: '192.168.1.5' });
  const forms = ['::ffff:192.168.1.7', '[::ffff:192.168.1.8]:51234', '192.168.1.6, 10.0.0.1', '::1', 'fd00::1'];
  const clients = [];
  for (const ip of forms) clients.push(await connect(p, { ip }));
  for (const c of clients) {
    assert.strictEqual(peers(c).length, 1 + clients.length, `${forms.join(',')} 未进入同一房间`);
  }
  a.ws.close(); clients.forEach((c) => c.ws.close()); s.stop();
});

test('同一 /64 下的两个公网 IPv6 互相可见', async () => {
  const p = port();
  const s = await startServer(p);
  const a = await connect(p, { ip: '240e:460:4c78:36cf:1111:2222:3333:4444' });
  const b = await connect(p, { ip: '240e:460:4c78:36cf:5555:6666:7777:8888' });
  assert.strictEqual(peers(a).length, 2, '同 /64 的 IPv6 未分到同一房间');
  const c = await connect(p, { ip: '240e:460:4c78:9999::1' });
  assert.strictEqual(peers(a).length, 2, '不同 /64 不应互相可见');
  a.ws.close(); b.ws.close(); c.ws.close(); s.stop();
});

test('房间密码正确才进入指定房间,错误则降级', async () => {
  const p = port();
  const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'ic-'));
  require('fs').writeFileSync(
    path.join(dir, 'room_pwd.json'),
    JSON.stringify([{ roomId: 'abc', pwd: '5f4dcc3b5aa765d61d8327deb882cf99', turns: [{ urls: ['turn:x'] }] }]),
  );
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), String(p)], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(600);

  const open = (url, ip) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}${url}`, { headers: { 'X-Forwarded-For': ip } });
    const msgs = [];
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    ws.on('open', () => setTimeout(() => resolve({ ws, msgs }), 250));
  });

  const ok = await open('/ws/abc/5f4dcc3b5aa765d61d8327deb882cf99', '8.8.8.8');
  const okReg = reg(ok);
  assert.strictEqual(okReg.data.roomId, 'abc');
  assert.deepStrictEqual(okReg.data.turns, [{ urls: ['turn:x'] }]);

  const bad = await open('/ws/abc/wrong', '9.9.9.9');
  assert.strictEqual(reg(bad).data.roomId, null, '错误密码应降级到公共房间');

  // 不同公网 IP 的用户通过房间号互相可见
  const other = await open('/ws/abc/5F4DCC3B5AA765D61D8327DEB882CF99', '8.8.4.4');
  assert.strictEqual(peers(ok).length, 2, '房间内用户应互相可见(密码大小写不敏感)');

  ok.ws.close(); bad.ws.close(); other.ws.close(); child.kill('SIGKILL');
});

test('不能冒用他人 uid 发消息', async () => {
  const p = port();
  const s = await startServer(p);
  const a = await connect(p, { ip: '10.0.0.1' });
  const b = await connect(p, { ip: '10.0.0.2' });
  const bobBefore = peers(a).length;
  // A 冒充 B 给 B 发 offer
  a.ws.send(JSON.stringify({ uid: myId(b), targetId: myId(b), type: '9002', data: { targetAddr: { sdp: 'x' } } }));
  await sleep(300);
  assert.strictEqual(b.msgs.filter((m) => m.type === '1005').length, 0, '冒用 uid 应被拒绝');
  // 正常转发
  a.ws.send(JSON.stringify({ uid: myId(a), targetId: myId(b), type: '9002', data: { targetAddr: { sdp: 'x' } } }));
  await sleep(300);
  const offer = b.msgs.find((m) => m.type === '1005');
  assert.ok(offer, '正常 offer 应被转发');
  assert.strictEqual(offer.data.targetId, myId(a));
  a.ws.close(); b.ws.close(); s.stop();
});

test('关闭浏览器后广播的列表里不再包含该用户', async () => {
  const p = port();
  const s = await startServer(p);
  const a = await connect(p, { ip: '10.0.0.1' });
  const b = await connect(p, { ip: '10.0.0.2' });
  assert.strictEqual(peers(a).length, 2);
  b.ws.close();
  await sleep(500);
  assert.deepStrictEqual(peers(a), [myId(a)]);
  a.ws.close(); s.stop();
});

test('id 在并发连接下唯一', async () => {
  const p = port();
  const s = await startServer(p);
  const clients = await Promise.all(
    Array.from({ length: 60 }, (_, i) => connect(p, { ip: `10.9.0.${i}` })),
  );
  const ids = clients.map(myId);
  assert.strictEqual(new Set(ids).size, ids.length, '存在重复 id');
  clients.forEach((c) => c.ws.close());
  s.stop();
});

test('room_pwd.json 损坏时服务仍能启动', async () => {
  const p = port();
  const dir = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'ic-'));
  require('fs').writeFileSync(path.join(dir, 'room_pwd.json'), '{ broken json');
  const child = spawn(process.execPath, [path.join(ROOT, 'index.js'), String(p)], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(700);
  assert.strictEqual(child.exitCode, null);
  const res = await fetch(`http://127.0.0.1:${p}/`);
  assert.strictEqual(res.status, 200);
  child.kill('SIGKILL');
});
