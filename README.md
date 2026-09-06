# plugim

插件化即时通讯

## 特性

- 一切皆插件：后端模块与前端 UI 挂载在同一个 `@plugim/core` 插件模型上，声明依赖即自动等待、按拓扑序启动
- 前后端解耦：单一 wire protocol（WebSocket 事件流 + RPC），两端共享 `@plugim/protocol` 类型

## 目录结构

```
plugim/
├── packages/
│   ├── core/          插件运行时（Context / provide / inject / 事件总线 / 插件生命周期）
│   └── protocol/      共享协议：envelope 帧定义（event / rpc / rpc:ok / rpc:err）
├── apps/
│   ├── server/        Hono + @hono/node-ws + Drizzle
│   │   └── src/plugins/
│   │       ├── config.ts    环境配置（DB 驱动、端口）
│   │       ├── gateway.ts   WS Hub + RPC 注册表 + HTTP 兜底（POST /rpc/:method）
│   │       ├── storage.ts   sqlite / postgres 双驱动消息存储
│   │       └── chat.ts      message.send / history.list 业务
│   └── web/           Vite + React + Tailwind
│       └── src/plugins/
│           ├── connection.ts  WS adapter + 自动重连 + RPC client
│           ├── sender.ts      发消息能力（本身是插件）
│           ├── echo-bot.ts    演示插件：非 bot 消息自动回 echo
│           └── chat-ui.tsx    聊天界面（气泡 + 连接状态）
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

HTTP：`POST /rpc/<method>`，body 为 `{"params":{...}}`。

## 路线图

- [ ] 多会话 / 房间列表
- [ ] 消息分页与去重 seq
- [ ] 用户身份（昵称 / 登录）
- [ ] Redis 缓存层
- [ ] Postgres 部署联调
