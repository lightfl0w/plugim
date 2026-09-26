# plugim

插件化即时通讯

## 特性

- 一切皆插件：后端模块与前端界面挂载在同一个 `@plugim/core` 插件模型上，声明依赖即自动等待，按拓扑顺序启动
- 前后端解耦：单一 wire protocol，WebSocket 事件流加 RPC，两端共享 `@plugim/protocol` 类型
- 账号体系：注册登录、改密、管理员重置，argon2 密码哈希加 JWT，WS 与 HTTP 双通道鉴权，消息身份由服务端绑定
- 关系链：好友申请、同意、拒绝、删除、屏蔽，备注只对自己可见
- 群组：建群、成员与管理员、全员禁言、群公告、群文件、邀请码与加群审批、群内禁止互加好友
- 消息：文本、图片、语音、文件、引用回复、单条与合并转发、@提及与 @全体成员、服务端搜索、已读回执、输入中状态、免打扰
- 通话：语音、视频、屏幕共享、群组通话，信令走 WebSocket，媒体走 WebRTC
- 客户端：桌面双栏、移动端 H5 响应式布局、独立聊天小窗、PWA 与离线 Web Push
- 运维：安装向导、单端口生产部署、管理后台覆盖用户、消息检索、文件管理、定时任务与数据统计，媒体可存本地磁盘或 S3 兼容对象存储

## 目录结构

```
plugim/
├── packages/
│   ├── core/          插件运行时：Context、服务注册表、事件总线、插件生命周期
│   └── protocol/      共享协议：envelope 帧定义 event / rpc / rpc:ok / rpc:err
├── apps/
│   ├── server/        Hono + @hono/node-ws + Drizzle
│   │   └── src/plugins/
│   │       ├── config.ts        环境配置：数据库、端口、JWT 密钥、VAPID、存储驱动
│   │       ├── gateway.ts       WS Hub、RPC 注册表、连接身份与心跳保活
│   │       ├── storage.ts       sqlite 与 postgres 双驱动，建表与全部 Store
│   │       ├── auth.ts          argon2 加 JWT 注册登录，改密与重置后旧 token 失效
│   │       ├── friends.ts       好友关系链与备注 RPC
│   │       ├── group.ts         群组、成员、禁言、邀请码与互加好友管控
│   │       ├── group-files.ts   群文件列表、添加与删除
│   │       ├── chat.ts          发消息、历史分页、服务端搜索、转发、输入中
│   │       ├── screen.ts        单聊与群聊的音视频、屏幕共享信令
│   │       ├── files.ts         上传接口、文件托管，本地磁盘或 S3
│   │       ├── push.ts          VAPID 密钥与 Web Push 投递
│   │       ├── tasks.ts         定时任务：过期消息清理与孤儿媒体清扫
│   │       ├── admin.ts         管理后台 RPC
│   │       ├── install.ts       安装向导 RPC
│   │       └── web.ts           前端静态托管与 SPA fallback
│   └── web/           Vite + React + Tailwind
│       └── src/
│           ├── host.tsx            ui 服务、导航栏与路由宿主
│           └── plugins/
│               ├── registry.ts          插件注册表与停用列表
│               ├── auth.ts / connection.ts / sender.ts
│               │                        非 UI 插件：token、WS 与 RPC 通道、消息发送
│               ├── cache.ts / presence.ts / groups.ts / friends.ts
│               │                        客户端状态：消息缓存、在线、群组、备注
│               ├── settings.ts / theme.ts
│               │                        插件设置与主题
│               ├── ui-shell.tsx         页面骨架与鉴权包装
│               ├── ui-views.tsx         全部界面段，按槽位注册
│               └── ui-*.tsx             单个界面模块，由 ui-views 挂载
├── docs/              VitePress 部署与开发文档
├── biome.json
└── pnpm-workspace.yaml
```

## 快速开始

```sh
pnpm install
pnpm dev:server
pnpm dev:web
```

首次打开站点进入安装向导。

## 配置

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `PORT` | `3000` | 服务端口，页面、RPC 与 WebSocket 共用 |
| `PLUGIM_DB_DRIVER` | `sqlite` | 设为 `postgres` 切换驱动 |
| `PLUGIM_DB_FILE` | `data/plugim.db` | SQLite 文件路径 |
| `DATABASE_URL` | `postgres://localhost:5432/plugim` | Postgres 连接串 |
| `PLUGIM_JWT_SECRET` | 内置开发密钥 | 生产环境必须改 |

完整清单与优先级见 [docs/config/env.md](docs/config/env.md)，安装向导写入的 `data/install.json` 优先级最高。

## 脚本

| 命令 | 说明 |
|------|------|
| `pnpm dev:server` / `pnpm dev:web` | 开发模式，服务端带 watch |
| `pnpm build` | 构建前端与后端产物 |
| `pnpm start` | 单端口生产启动，需先 `pnpm build` |
| `pnpm test` | 全部 vitest |
| `pnpm typecheck` | 全仓 tsc --noEmit |
| `pnpm lint` / `pnpm lint:fix` | Biome 检查 / 自动修复 |
| `pnpm docs:dev` / `pnpm docs:build` | VitePress 文档站，含部署与开发两部分 |

## 路线图

- [x] 用户身份与账号安全：注册、登录、改密、管理员重置
- [x] 好友关系链：申请、同意、拒绝、删除、屏蔽、备注
- [x] 多会话列表：私聊与群聊
- [x] 消息分页：时间戳与消息 id 组成游标
- [x] 群组与权限：成员、管理员、全员禁言、邀请码、加群审批、禁止互加好友
- [x] 消息能力：富媒体、引用、转发、搜索、@提及、已读回执、输入中
- [x] 实时通话：语音、视频、屏幕共享、群组通话
- [x] 客户端布局：移动端 H5 响应式、独立聊天小窗
- [x] 管理后台、安装向导与定时清理
- [x] PWA 与离线 Web Push
- [ ] Postgres 部署联调
- [ ] Redis 缓存层
