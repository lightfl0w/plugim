# 生产部署

## 运行形态

生产只有一个进程、一个端口：

| 路径 | 用途 |
| --- | --- |
| `/`、`/chat`、`/admin` 等页面 | `apps/web/dist` 里的静态文件，没有对应文件时回退到 `index.html` |
| `POST /rpc/:method` | 业务接口，请求带 Bearer token |
| `POST /upload` | 媒体上传，请求体是文件，需要 Bearer token |
| `GET /files/:key` | 媒体读取，本地磁盘走文件流，S3 跳转到公开前缀或预签名地址 |
| `GET /ws` | WebSocket 实时通道 |
| `GET /health`、`GET /version` | 探活与版本 |

前端请求全部走相对路径，反向代理只需要转发这一个上游。

## 配置来源与优先级

从高到低：

1. `data/install.json`，安装向导写入（`dbDriver`、`dbFile`、`databaseUrl`、`logDir`）
2. 进程环境变量
3. `.env` 文件

`.env` 会从当前工作目录、`apps/server`、仓库根等位置向上查找，也会读 `/etc/plugim/.env`，加载时不会覆盖已存在的环境变量。全部变量见[环境变量参考](/config/env)。

## 最小生产示例

```bash
cd /opt/plugim
cp .env.example .env
openssl rand -hex 32          # 填进 .env 的 PLUGIM_JWT_SECRET
pnpm install && pnpm build
pnpm start
```

只用二进制运行时连 Node 都不需要，把 `apps/web/dist` 与 `apps/server/target/release/plugim-server`
拷到目标机即可（见下面的容器与 systemd 示例）。

::: danger
不设置 `PLUGIM_JWT_SECRET` 时用的是内置开发密钥，启动日志会打印告警。拿到这个密钥就能伪造任意用户的会话，公网部署必须设置。
:::

## systemd 托管

`/etc/systemd/system/plugim.service`：

```ini
[Unit]
Description=plugim IM
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=plugim
WorkingDirectory=/opt/plugim
EnvironmentFile=/opt/plugim/.env
ExecStart=/opt/plugim/apps/server/target/release/plugim-server
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=25
KillMode=mixed
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin plugim
sudo chown -R plugim:plugim /opt/plugim
sudo systemctl daemon-reload
sudo systemctl enable --now plugim
journalctl -u plugim -f
```

安装向导里点「保存并继续」会让进程自己退出，systemd 的 `Restart=always` 负责把它拉起来，属正常现象。

## pm2 托管

不用 systemd 时可以用 pm2：

```bash
pnpm install -g pm2
cd /opt/plugim && pnpm install && pnpm build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`ecosystem.config.cjs` 直接拉起编译好的二进制，配好单实例 fork 模式、崩溃自动重启、`kill_timeout` 15 秒等待，
日志默认走 `data/logs/pm2-*.log`。

`instances` 必须是 1：WebSocket 连接状态都在单进程内存里，开 cluster 会各有各的连接表。

## Docker

仓库自带 `Dockerfile`（三段构建：Node 构建前端 → Rust 构建后端 → Debian slim 运行时）和
`docker-compose.yml`：

```bash
docker compose up -d --build          # SQLite，数据在 plugim-data 卷
docker compose --profile pg up -d     # 额外起一个 PostgreSQL
```

容器内的约定：

| 变量 | 值 |
| --- | --- |
| `PLUGIM_WEB_DIST` | `/app/web`（镜像内已放好前端产物） |
| `PLUGIM_INSTALL_FILE` | `/app/data/install.json` |
| 数据库 | `/app/data/plugim.db` |
| 存储 | `/app/data/uploads` |
| 日志 | `/app/data/logs` |
| 备份 | `/app/data/backups` |

`/app/data` 是数据卷，重建容器不会丢数据。要连 compose 里的 PostgreSQL，在仓库根建一个 `.env`（compose 会自动读取）：

```bash
PLUGIM_DB_DRIVER=postgres
DATABASE_URL=postgres://plugim:plugim@postgres:5432/plugim
```

也可以直接写进 `app` 服务的 `environment`。装完向导写入的 `install.json` 优先级最高，用过向导之后以向导的选择为准。

镜像里带 `postgresql-client`，所以「数据库备份」定时任务在容器内也能用 `pg_dump`。

## 前端产物路径

服务端按顺序探测静态目录，找到含 `index.html` 的第一个就用：

1. `PLUGIM_WEB_DIST` 指向的路径
2. 常见布局下的 `apps/web/dist`、`../web/dist`

都找不到就退化成纯接口服务，和开发模式一样。前端产物不在默认位置时用 `PLUGIM_WEB_DIST` 指定。

## 运行指标

服务端默认开启 Prometheus 格式的指标端点：

```bash
curl http://127.0.0.1:3000/metrics        # Prometheus 文本格式
curl http://127.0.0.1:3000/metrics.json   # 结构化快照，便于脚本消费
```

指标分两类：全局 gauge/counter（`plugim_uptime_seconds`、`plugim_websocket_connections`、`plugim_messages_sent_total`、`plugim_http_requests_total`、`plugim_http_errors_total`、`plugim_event_loop_lag_ms`、`plugim_memory_rss_bytes`、`plugim_memory_heap_used_bytes`），以及按 RPC 方法拆分的调用量与延迟直方图（`plugim_rpc_calls_total{method=...}`、`plugim_rpc_errors_total{method=...}`、`plugim_rpc_duration_ms_bucket/sum/max{method=...}`）。

拉取 `/metrics` 本身不计入 HTTP 请求数，避免监控轮询污染数据。直方图桶为 5ms 到 5000ms 共 10 档，另有 `+Inf`。

慢调用会直接打进日志，方便不看监控时也能发现：

```bash
grep 'slow rpc' data/logs/server-*.log
```

阈值默认 1500 毫秒，用 `PLUGIM_SLOW_RPC_MS` 调整。调成 0 可以关闭慢调用日志。

接入 Prometheus 时在反向代理上限制 `/metrics` 的访问来源，不要暴露到公网。

## 日志

- 不配置日志目录：日志走 stdout，交给 journald 或容器日志驱动。
- 配置了日志目录（向导里填的，或 `PLUGIM_LOG_DIR`）：额外按天写一份到 `<logDir>/server-YYYY-MM-DD.log`，跨天自动切到新文件，进程不用重启。
- 单文件超过 `PLUGIM_LOG_MAX_BYTES`（默认 8 MiB）切成 `server-YYYY-MM-DD.1.log`、`.2.log`，避免一份日志无限涨。
- 超过 `PLUGIM_LOG_KEEP_DAYS`（默认 14 天）和超过 `PLUGIM_LOG_KEEP_FILES`（默认 200 份）的旧文件，在启动和每次切分时清掉。
- 无论是否配置日志目录，日志都会同时写 stdout，容器与 journald 都能照常收集。

## 数据库

个人或 50 人以下的内网环境用 SQLite 就够，数据全在一个文件里，备份就是拷文件。多人、公网环境建议 PostgreSQL，连接串形如 `postgres://user:pass@host:5432/db`。

SQLite 默认开 WAL、`synchronous=NORMAL`、`busy_timeout=5000`，写入不会因为备份或读操作直接报 `database is locked`。备份走 `VACUUM INTO` 生成一致性快照，PostgreSQL 走 `pg_dump`，见[备份与升级](/guide/backup#自动备份)。

表结构在启动时自动创建和补齐，不用手工跑迁移。

## 后台运维

管理员登录后点会话列表底部的盾牌图标进后台：

- 用户管理：设为管理员、封禁与解封
- 群组管理：查看群主与人数，解散任意群
- 消息检索：按关键字、发送者查询，支持分页
- 文件管理：媒体文件列表，含上传者、大小与占用合计；可以下载、删除单个文件，也能在这里切换本地磁盘与 S3 存储、改单文件上限，改完点「检测存储」确认可读写
- 定时任务：过期消息清理、孤儿文件清理、数据库备份三个任务，可以改执行周期、停用或立即执行，页面显示上次执行时间和结果
- 系统设置：注册用户、群组、在线连接、消息总数、媒体占用、按天消息量与活跃用户趋势图；消息保留天数，0 表示不限制；站点名称与图标；系统更新

## 一键更新

系统设置页有「系统更新」卡片，管理员点「检查更新」后会 `git fetch origin main` 并比较本地与远端，显示当前 commit、落后提交数与待更新 commit 列表。确认后点「立即更新」，服务会：

1. 派生一个脱离服务进程的 `scripts/self-update.sh` 执行更新，服务本身继续响应
2. 更新器依次执行 `git fetch`、`git merge --ff-only origin/main`、`pnpm install`、`pnpm build`，进度写在 `data/update-status.json`，后台每 2 秒轮询展示
3. 构建成功后重启服务：pm2 用 `pm2 restart plugim`，systemd 用 `systemctl restart plugim.service`，都没有时对旧进程发 `SIGTERM`，再以 `nohup` 拉起新的二进制
4. 客户端重连后比对 `/version` 的 `buildId`（git short hash），与本地记录不一致就自动刷新，拿到新的前端产物

构建失败会自动 `git checkout` 回滚到原 commit 并上报错误，不会留下半更新状态。

前提与注意：

- 必须是 git 克隆部署，且仓库配置了远端；用 tarball 或 dist-only 部署时卡片会说明原因并禁用更新
- 更新拉取固定的 `origin/main`，本地有未提交改动时会拒绝更新，避免冲突
- **服务器需要 Rust 工具链**：更新器会执行 `pnpm build`，其中包含 `cargo build --release`。只装二进制的部署方式不能自更新
- 容器部署同理：镜像里不含 `.git` 与 `scripts/`，一键更新会自动降级禁用，改用拉取新镜像重启
- 服务重启期间有几十秒短暂不可用，客户端会显示维护横幅
- 首次拉取依赖可能较慢，期间不要重复点击；进度与历史记录见 `data/update.log`
- 生产环境建议先备份数据库，见[备份与升级](/guide/backup)

删文件会先查引用：还有消息指向该文件（包括被转发出去的消息）时拒绝删除，要先删掉相关消息。上传后一直没被引用的文件，由孤儿文件清理任务在 24 小时后回收。

## 上线前检查

- `PLUGIM_JWT_SECRET` 已随机生成，且没有跟着仓库走
- 注册策略按需要收紧（邀请码或关闭注册）
- HTTPS 已配置，非 localhost 访问时浏览器只在安全上下文里开放麦克风、摄像头
- 公网环境已配 TURN，见 [TURN 音视频中继](/guide/turn)
- 数据库备份已安排，见 [备份与升级](/guide/backup)
