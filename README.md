# 发个东西
一个局域网文字/文件P2P传输工具
> 项目中仅在线用户列表和WebRTC信令迫不得已需要一个轻量化的服务，其他数据传输都采用了基于WebRTC的点对点传输，不经过中间服务器，所以局域网内互传一些文字/文件都比较快。

demo演示：https://fagedongxi.com

## 优点
无需安装任何软件，打开浏览器，无需登录直接传输。

## 缺点
接收大文件比较吃内存（单文件几百兆一般没问题）

## 场景：
比如新装的win系统需要从mac系统传一些需要🪜才能下载的软件或者搜到的一些东西

## 部署/启动
> 自`1.1.0`版本后，不再需要单独部署网页端了，仅启动一个服务端即可

参考视频：https://v.douyin.com/zp_dXkV1fys/

### 源码方式
1. 安装nodejs，node版本没有测试，我用的是 `16.20.2`
2. 下载源码
3. 进入 项目根目录，运行 `npm install`
4. 运行 `npm run start [port]` ，例如 `npm run start 8081`

### 二进制方式
* 下载对应平台的可执行文件，直接执行即可
* 默认监听 `8081` 端口，可通过参数指定端口，例如 `./internal-chat-linux 8082`
* 如果你用windows，可参考 https://v.douyin.com/CeiJahpLD/ 注册成服务

## 房间配置
* 配置文件名：`room_pwd.json`
* 存放目录：应用同级目录
* 格式：参考样例 `.room_pwd.json`

## 常见问题：
在线列表看见对方，但一直处于断开的状态且无法发送消息：
* 原因一：浏览器不支持WebRTC（目前最新版已经在用户打开后自动检测并加入提示），旧版没有检测功能可以临时用这个进行测试：https://space.coze.cn/s/qDNpw1y7MJw/
* 原因二：网络环境不支持互相访问，详见：https://v.douyin.com/IPoHlTBzngg/
  > 常见于：公司/学校网络开启了客户端隔离（AP isolation）、双方在同一个 WiFi 但分属不同 VLAN、
  > 或者一边走 IPv4 一边走 IPv6。可以先用 `chrome://webrtc-internals` 看 ICE 是否一直在 checking。
  >
  > 解决方案：
  >  1. 私有部署「发个东西」+「TURN中转服务coturn」
  >  2. 配置房间增加TURN支持（ `.room_pwd.json` 样例文件中有TURN的配置格式）

### 房间与分组规则
不填房间号时，服务端按来源 IP 自动分组，双方必须在同一组才能互相看见：

| 来源 IP | 分到哪一组 |
| --- | --- |
| 192.168.x.x / 10.x.x.x / 172.16-31.x.x / 127.x.x.x | 统一进 `internal`（同一局域网互相可见） |
| 公网 IPv4 | 按完整 IP 分组（同一 NAT 出口的用户互相可见） |
| 公网 IPv6 | 按 /64 前缀分组（同一条宽带下的设备互相可见） |

如果同一局域网里的设备却互相看不到，通常是经过了反向代理且没有正确透传客户端 IP，
请确认 nginx 配置了 `X-Real-IP` / `X-Forwarded-For`（见下方样例）。

## 目录结构
```
index.js                 入口：组装各模块、监听端口
src/
  logger.js              带时间戳的日志
  protocol.js            信令类型码（服务端与前端共用口径）
  rooms.js               room_pwd.json 加载
  net/ip.js              客户端 IP 归一化与房间分组
  users/registry.js      在线用户表
  http/static.js         静态文件服务（含路径穿越防护）
  signaling/server.js    WebSocket 信令转发
www/
  index.html             页面
  style.css              样式
  js/
    core/utils.js        常量 / 工具
    core/md5.js          房间密码摘要
    core/transfer.js     文件分片、重组、重传（与 UI 无关）
    signaling-client.js  信令连接与断线重连
    rtc/peer.js          单个对端的 WebRTC 连接
    ui/dialog.js         模态框 / toast
    ui/chat-view.js      聊天记录渲染
    ui/user-list.js      在线用户列表
    ui/file-send-dialog.js 文件发送对话框
    ui/file-drop.js      拖拽 / 选择 / 粘贴文件
    app.js               主控制器：串联信令、连接、UI
    main.js              启动入口
test/server.test.js      服务端回归测试（npm test）
```

## 测试
```
npm test
```
覆盖：非法消息/畸形 URL 不崩服务、路径穿越、房间分组（IPv4/IPv6）、
密码校验、uid 冒用、掉线广播、并发 id 唯一性、配置文件损坏容错。


### nginx代理配置样例
```
server
{
  server_name fagedongxi.com;
  index index.html;
  listen 80;

  location / {
    proxy_pass  http://127.0.0.1:8081/;
  }

  location /ws/ {
      proxy_pass http://127.0.0.1:8081/ws/;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

}
```
## 免责声明：
本项目仅用于学习交流，请勿用于非法用途，否则后果自负。
