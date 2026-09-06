# plugim

插件化即时通讯

## 特性

- 一切皆插件：后端模块与前端 UI 挂载在同一个 `@plugim/core` 插件模型上，声明依赖即自动等待、按拓扑序启动
- 前后端解耦：单一 wire protocol（WebSocket 事件流 + RPC），两端共享 `@plugim/protocol` 类型
- 账号体系：注册 / 登录（argon2 密码哈希 + JWT），WS 与 HTTP 双通道鉴权，消息身份由服务端绑定
- 关系链：好友申请 / 同意 / 拒绝 / 删除 / 屏蔽，定向事件实时通知

## 目录结构

```
plugim/
├── packages/
│   ├── core/          插件运行时（Context / provide / inject / 事件总线 / 插件生命周期）
│   └── protocol/      共享协议：envelope 帧定义（event / rpc / rpc:ok / rpc:err）
├── apps/
│   ├── server/        Hono + @hono/node-ws + Drizzle
│   │   └── src/plugins/
│   │       ├── config.ts    环境配置（DB 驱动、端口、JWT 密钥）
│   │       ├── gateway.ts   WS Hub + RPC 注册表 + 连接身份 + HTTP 兜底
│   │       ├── storage.ts   sqlite / postgres 双驱动（messages / users / friendships）
│   │       ├── auth.ts      argon2 + JWT 注册登录
│   │       ├── friends.ts   好友关系链 RPC
│   │       └── chat.ts      message.send / history.list
│   └── web/           Vite + React + Tailwind
│       └── src/plugins/
│           ├── auth.ts              token 持久化 + 登录注册
│           ├── connection.ts        WS adapter + token 鉴权 + 自动重连
│           ├── sender.ts            发消息能力（本身是插件）
│           ├── friends.ts           好友 RPC 封装 + 事件订阅
│           ├── shell.tsx            UI 槽位注册表（sidebar/header/messages/composer/overlay/auth）
│           ├── ui-auth.tsx          登录/注册卡片 → auth 槽
│           ├── ui-sidebar.tsx       会话 + 好友列表 → sidebar 槽
│           ├── ui-header.tsx        状态/用户名/好友入口 → header 槽
│           ├── ui-messages.tsx      消息流 → messages 槽
│           ├── ui-composer.tsx      输入框 + 发送 → composer 槽
│           └── ui-friends-panel.tsx 好友管理弹层 → overlay 槽
├── biome.json  
└── pnpm-workspace.yaml
```

## 快速开始

```sh
pnpm install
pnpm dev:server
pnpm dev:web
```

默认 SQLite

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PLUGIM_DB_DRIVER` | `sqlite` | 设为 `postgres` 切换驱动 |
| `DATABASE_URL` | — | Postgres 连接串（切驱动时必填） |
| `PLUGIM_PORT` | `3000` | 服务端口 |

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev:server` / `pnpm dev:web` | 开发模式（server 带 watch） |
| `pnpm typecheck` | 全仓 tsc --noEmit |
| `pnpm lint` / `pnpm lint:fix` | Biome 检查 / 自动修复 |
| `pnpm --filter @plugim/web build` | 前端生产构建 |

## 协议

单条 WebSocket 连接复用两种帧：

- **事件流**（server → client）：`message:new` 等内核事件广播
- **RPC**（client → server）：`{"kind":"rpc","id":"r1","method":"message.send","params":{...}}`，回包 `rpc:ok` / `rpc:err`

HTTP：`POST /rpc/<method>`，body 为 `{"params":{...}}`，携带 `Authorization: Bearer <token>` 可鉴权。

鉴权：WS 连接通过 `?token=<jwt>` 携带身份；`auth.register` / `auth.login` 无需 token，其余消息与好友 RPC 均要求登录。

## 路线图

- [x] 用户身份（注册 / 登录 / JWT）
- [x] 好友关系链（申请 / 同意 / 拒绝 / 删除 / 屏蔽）
- [ ] 多会话 / 房间列表（私聊 + 群聊）
- [ ] 消息分页与去重 seq
- [ ] Redis 缓存层
- [ ] Postgres 部署联调
