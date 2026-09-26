# 安装与初始化

## 环境要求

- Node.js 20 以上，推荐 22 LTS。启动时会检查版本，低于 20 直接退出。
- pnpm。版本由仓库里的 `packageManager` 字段锁定。
- 数据库不用提前准备，默认用内置的 SQLite，生产环境可以换 PostgreSQL。

## 获取代码

```bash
git clone https://github.com/lightfl0w/plugim.git
cd plugim
pnpm install
```

## 构建与启动

```bash
pnpm build
```

构建分两步：`apps/web` 用 Vite 产出静态文件到 `apps/web/dist`；`apps/server` 用 tsup 打包成单文件 `apps/server/dist/index.js`，better-sqlite3、argon2 这类原生模块保持为外部依赖。

```bash
pnpm start
```

默认监听 3000。只要 `apps/web/dist` 存在，同一个端口就同时提供页面、`/rpc/*` 接口和 `/ws` WebSocket，不需要另外起静态服务器；没有这个目录时只提供接口。

```bash
curl http://localhost:3000/health   # {"ok":true,"connections":0}
curl http://localhost:3000/version  # {"name":"plugim","version":"0.1.0",...}
```

## 安装向导

浏览器打开站点，服务端发现还没初始化会自动跳到 `/install`，三步走完：

1. 数据库与日志。SQLite 填 `.db` 文件路径（例如 `data/plugim.db`），PostgreSQL 填 `postgres://` 连接串。日志目录可以不填，填了之后控制台日志会按天写一份到该目录。点「测试连接」验证，点「保存并继续」把配置写进 `data/install.json` 并自动重启进程，重启后回到向导第二步。
2. 创建管理员。第一个注册的用户就是管理员，这个表单建完号直接登录。
3. 注册策略。开放注册、邀请码注册、关闭注册三选一，选邀请码就填码。提交后安装完成，进入聊天页。

::: warning
`data/install.json` 的优先级比环境变量和 `.env` 都高。装完想换数据库，改这个文件再重启即可；想重新走一遍向导，把它删掉。
:::

## 开发模式

```bash
pnpm dev:server   # tsx watch，端口 3000
pnpm dev:web      # vite，端口 5173，自动代理 /rpc 与 /ws
```

开发时前端没有构建产物，3000 端口只有接口，日常访问 5173。
