# 部署说明

## 组成

| 服务 | 作用 | 内存 |
| --- | --- | --- |
| `app` | 静态页面 + WebSocket 信令 | ~10 MB |
| `coturn` | 异地对等连接打洞失败时的中继 | ~5 MB |

静态文件和数据表面上行流量走 `app`；P2P 直连成功后，文件不经过服务器。

## 网络拓扑

```
浏览器 ──HTTPS/WS──> Cloudflare 隧道 ──> app:8081   (komari-net，不映射宿主端口)
浏览器 ──UDP 3478/TURN──> coturn                     (host 网络，公网 IP 直连)
```

- **信令和页面**走 Cloudflare 隧道，不需要开放任何服务器端口。
- **TURN 中继**必须直连公网 IP：隧道只代理 HTTP/WebSocket，代理不了 TURN 需要的 UDP。
  这意味着服务器的公网 IP 是公开的。

## 部署步骤

```bash
cd /opt/stacks/internal-chat

# 1. 配置 TURN 密码（两边必须一致）
openssl rand -hex 12
#   填入 turnserver.conf 的 user=chat:<密码>

# 2. 配置房间
#   room_pwd.json 里 pwd 字段是 md5(明文密码)：
#   echo -n '你的房间密码' | md5sum
#   turns 里的 credential 与上一步的 TURN 密码保持一致

# 3. 启动
docker compose up -d --build

# 4. 查看状态
docker compose ps
docker compose logs -f app
```

## 阿里云安全组

TURN 需要放行以下端口（入方向，UDP）：

| 端口 | 用途 |
| --- | --- |
| `3478` | TURN/STUN 监听 |
| `49160-49200` | 中继端口段（每个会话占 2 个，约支撑 20 个并发中继） |

> 若并发中继数需要更多，调整 `turnserver.conf` 的 `min-port`/`max-port`，
> 安全组规则同步放开。端口段越宽，单条安全组规则能覆盖的会话越多。

## Cloudflare 隧道

在 Cloudflare Zero Trust 面板添加路由：

| 域名 | 服务 |
| --- | --- |
| `你的域名` | `http://internal-chat:8081` |

隧道容器（`cloudflared`）与 `app` 同在 `komari-net` 网络，可直接用容器名解析。
WebSocket 由 Cloudflare 自动支持，无需额外配置。

## 房间与 TURN 的关系

- 不填房间号 → 服务端按来源 IP 自动分组，双方必须同一局域网/同一公网出口才能互相看见
- 填房间号（`https://你的域名/房间号`）→ 跳过 IP 分组，任意网络的人都进同一个房间
- 房间配置里带 `turns` → 前端自动加载 TURN，打洞失败时走中继

**异地传输必须使用房间号**，否则服务端根本不会把双方放进同一个房间，TURN 也用不上。

## 验证命令

```bash
# 页面与健康状态
curl -I http://127.0.0.1:18081/   # 临时映射时使用

# TURN 是否在监听
ss -lunp | grep 3478

# TURN 中继自测（在容器内执行）
docker exec internal-chat-turn turnutils_uclient -v -u chat -w <密码> -p 3478 -y <内网IP> <内网IP>
```

## 已知限制

- Cloudflare 免费版对 WebSocket 有连接时长限制，长期挂着的连接可能被断开；
  前端已实现自动重连，断开会自行恢复。
- 阿里云按流量计费，TURN 中继一个 1 GB 文件会消耗约 2 GB 流量（收 + 发）。
