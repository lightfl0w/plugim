# plugim

插件化即时通讯

## 特性

- 一切皆插件：后端模块与前端 UI 挂载在同一个 `@plugim/core` 插件模型上，声明依赖即自动等待、按拓扑序启动
- 前后端解耦：单一 wire protocol（WebSocket 事件流 + RPC），两端共享 `@plugim/protocol` 类型
- 账号体系：注册 / 登录（argon2 密码哈希 + JWT），WS 与 HTTP 双通道鉴权，消息身份由服务端绑定
- 关系链：好友申请 / 同意 / 拒绝 / 删除 / 屏蔽，定向事件实时通知
- 群组：建群、成员与管理员、全员禁言、成员之间禁止互加好友
- 消息：图片 / 文件、引用回复、单条与合并转发、已读回执、在线状态、免打扰
- 通话：语音、视频、屏幕共享，信令走 WebSocket，媒体走 WebRTC
- 运维：安装向导、管理后台（用户 / 消息检索 / 文件 / 策略）、PWA 与离线 Web Push、单端口生产部署

## 目录结构

```
plugim/
├── packages/
│   ├── core/          插件运行时（Context / provide / inject / 事件总线 / 插件生命周期）
│   └── protocol/      共享协议：envelope 帧定义（event / rpc / rpc:ok / rpc:err）
├── apps/
│   ├── server/        Hono + @hono/node-ws + Drizzle
│   │   └── src/plugins/
│   │       ├── config.ts    环境配置（DB 驱动、端口、JWT 密钥、VAPID）
│   │       ├── gateway.ts   WS Hub + RPC 注册表 + 连接身份 + 心跳保活
│   │       ├── storage.ts   sqlite / postgres 双驱动（用户 / 消息 / 群组 / 好友 / 订阅）
│   │       ├── auth.ts      argon2 + JWT 注册登录
│   │       ├── friends.ts   好友关系链 RPC
│   │       ├── group.ts     群组、成员、禁言与互加好友管控
│   │       ├── chat.ts      发消息、历史分页、转发
│   │       ├── screen.ts    音视频与屏幕共享信令
│   │       ├── push.ts      VAPID 密钥与 Web Push 投递
│   │       ├── admin.ts     管理后台 RPC
│   │       ├── install.ts   安装向导 RPC
│   │       └── web.ts       前端静态托管与 SPA fallback
│   └── web/           Vite + React + Tailwind
│       └── src/plugins/
│           ├── registry.ts          插件注册表
│           ├── auth.ts / connection.ts / sender.ts
│           │                        非 UI 插件：token、WS adapter、RPC 封装
│           ├── ui-shell.tsx         布局、路由与槽位宿主
│           ├── ui-views.tsx         全部 UI 插件，按槽位注册
│           └── ui-*.tsx             单个界面模块，由 ui-views 挂载
├── docs/              VitePress 部署文档
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
| `PORT` | `3000` | 服务端口，页面、RPC 与 WebSocket 共用 |
| `PLUGIM_DB_DRIVER` | `sqlite` | 设为 `postgres` 切换驱动 |
| `PLUGIM_DB_FILE` | `data/plugim.db` | SQLite 文件路径 |
| `DATABASE_URL` | `postgres://localhost:5432/plugim` | Postgres 连接串 |
| `PLUGIM_JWT_SECRET` | 内置开发密钥 | 生产环境必须改 |

完整清单与优先级（`data/install.json` > 环境变量 > `.env`）见 [docs/config/env.md](docs/config/env.md)。

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev:server` / `pnpm dev:web` | 开发模式（server 带 watch） |
| `pnpm build` | 构建前端与后端产物 |
| `pnpm start` | 单端口生产启动，需先 `pnpm build` |
| `pnpm test` | 全部 vitest |
| `pnpm typecheck` | 全仓 tsc --noEmit |
| `pnpm lint` / `pnpm lint:fix` | Biome 检查 / 自动修复 |
| `pnpm docs:dev` / `pnpm docs:build` | VitePress 文档站 |

## 路线图

- [x] 用户身份（注册 / 登录 / JWT）
- [x] 好友关系链（申请 / 同意 / 拒绝 / 删除 / 屏蔽）
- [x] 多会话 / 房间列表（私聊 + 群聊）
- [x] 消息分页（`history.list` 的 before + limit）
- [x] 群组与权限（成员 / 管理员 / 全员禁言 / 禁止互加好友）
- [x] 富媒体与消息操作（图片 / 文件 / 引用 / 转发）
- [x] 已读回执与在线状态
- [x] 实时通话（语音 / 视频 / 屏幕共享）
- [x] 管理后台与安装向导
- [x] PWA 与离线 Web Push
- [ ] Postgres 部署联调
- [ ] Redis 缓存层
