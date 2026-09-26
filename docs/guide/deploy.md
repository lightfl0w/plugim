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

`.env` 会从当前工作目录、`apps/server`、仓库根等位置向上查找，加载时不会覆盖已存在的环境变量。全部变量见[环境变量参考](/config/env)。

## 最小生产示例

```bash
cd /opt/plugim
cp .env.example .env
openssl rand -hex 32
# 把输出填进 .env 的 PLUGIM_JWT_SECRET
pnpm install && pnpm build
pnpm start
```

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
ExecStart=/usr/bin/node apps/server/dist/index.js
Restart=always
RestartSec=3

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

## 前端产物路径

服务端按顺序探测静态目录，找到含 `index.html` 的第一个就用：

1. `PLUGIM_WEB_DIST` 指向的路径
2. 常见布局下的 `apps/web/dist`、`../web/dist`

都找不到就退化成纯接口服务，和开发模式一样。前端产物不在默认位置时用 `PLUGIM_WEB_DIST` 指定。

## 日志

- 不配置日志目录：日志走 stdout，交给 journald 或容器日志驱动。
- 配置了日志目录（向导里填的，或 `PLUGIM_LOG_DIR`）：额外按天写一份到 `<logDir>/server-YYYY-MM-DD.log`。

## 数据库

个人或 50 人以下的内网环境用 SQLite 就够，数据全在一个文件里，备份就是拷文件。多人、公网环境建议 PostgreSQL，连接串形如 `postgres://user:pass@host:5432/db`。

表结构在启动时自动创建和补齐，不用手工跑迁移。

## 后台运维

管理员登录后点会话列表底部的盾牌图标进后台：

- 用户管理：设为管理员、封禁与解封
- 群组管理：查看群主与人数，解散任意群
- 消息检索：按关键字、发送者查询，支持分页
- 文件管理：媒体文件列表，含上传者、大小与占用合计；可以下载、删除单个文件，也能在这里切换本地磁盘与 S3 存储、改单文件上限，改完点「检测存储」确认可读写
- 定时任务：过期消息清理、孤儿文件清理两个任务，可以改执行周期、停用或立即执行，页面显示上次执行时间和结果
- 系统设置：注册用户、群组、在线连接、消息总数、媒体占用、按天消息量与活跃用户趋势图；消息保留天数，0 表示不限制

删文件会先查引用：还有消息指向该文件（包括被转发出去的消息）时拒绝删除，要先删掉相关消息。上传后一直没被引用的文件，由孤儿文件清理任务在 24 小时后回收。

## 上线前检查

- `PLUGIM_JWT_SECRET` 已随机生成，且没有跟着仓库走
- 注册策略按需要收紧（邀请码或关闭注册）
- HTTPS 已配置，非 localhost 访问时浏览器只在安全上下文里开放麦克风、摄像头
- 公网环境已配 TURN，见 [TURN 音视频中继](/guide/turn)
- 数据库备份已安排，见 [备份与升级](/guide/backup)
