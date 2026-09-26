# 环境变量

配置优先级从高到低：`data/install.json` > 进程环境变量 > `.env` 文件。

`.env` 从当前工作目录、`apps/server`、仓库根等位置向上逐级查找，加载时不会覆盖已经存在的环境变量。

## 服务

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口，页面、RPC、WebSocket 共用 |
| `PLUGIM_WEB_DIST` | 自动探测 | 前端静态目录；探测不到 `index.html` 时只跑接口 |
| `PLUGIM_LOG_DIR` | 空（不写文件） | 日志目录，按天写 `server-YYYY-MM-DD.log`；向导里的 `logDir` 优先 |

## 数据库

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLUGIM_DB_DRIVER` | `sqlite` | `sqlite` 或 `postgres`；向导写入的 `install.json` 优先 |
| `PLUGIM_DB_FILE` | `data/plugim.db` | SQLite 文件路径，相对进程工作目录 |
| `DATABASE_URL` | `postgres://localhost:5432/plugim` | PostgreSQL 连接串，仅 `dbDriver=postgres` 时使用 |

## 认证与注册

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLUGIM_JWT_SECRET` | 内置开发密钥 | 生产环境必须改，用 `openssl rand -hex 32` 生成；未设置时启动日志会告警 |
| `PLUGIM_ADMINS` | 空 | 引导管理员用户名，逗号分隔；这些用户名注册时自动获得管理员，留空则谁都不自动提升。仓库的 `.env.example` 里填的是 `admin` |
| `PLUGIM_ALLOW_REGISTER` | `true` | 设 `false` 关闭注册；后台「系统设置」或向导策略步骤写入数据库后，以数据库的值为准 |
| `PLUGIM_INVITE_CODE` | 空 | 非空则注册必须携带邀请码；同样会被后台策略覆盖 |

## 会话与实时

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLUGIM_DEFAULT_SESSION` | `general` | 默认频道名，即侧栏的「综合频道」 |
| `PLUGIM_STUN_URLS` | `stun:stun.l.google.com:19302` | STUN 列表，逗号分隔 |
| `PLUGIM_TURN_URL` | 空 | 形如 `turn:turn.example.com:3478?transport=udp`；空则不下发中继 |
| `PLUGIM_TURN_USER` | 空 | TURN 用户名 |
| `PLUGIM_TURN_PASS` | 空 | TURN 密钥，需与 coturn 的 `static-auth-secret` 一致 |

## 离线推送

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PLUGIM_VAPID_PUBLIC_KEY` | 空 | VAPID 公钥，和私钥同时设置才生效 |
| `PLUGIM_VAPID_PRIVATE_KEY` | 空 | VAPID 私钥 |
| `PLUGIM_VAPID_SUBJECT` | `mailto:admin@example.com` | 推送凭证的联系方式，`mailto:` 或站点 URL |

两个密钥都留空时，服务端首次启动会自动生成一对并写进 `settings` 表（键名 `vapid_public` / `vapid_private`），重启后继续用同一对。浏览器端 `PushManager.subscribe` 需要安全上下文，HTTPS 或 `localhost` 才可用；订阅存在 `push_subscriptions` 表，推送返回 404/410 时自动删除该订阅。用户离线（没有 WebSocket 连接）才发推送，只发文字预览，图片、文件等显示为类型占位。

判定在线与否只看 WebSocket 连接。网关每 30 秒给每条连接发一次 ping，连续两轮没有回应就断开并清掉身份，所以拔网线、直接关机这类不发 FIN 的掉线会在半分钟到一分钟内被当成离线，推送随即照常发。

## 安装锁定文件

`data/install.json`，路径可以用 `PLUGIM_INSTALL_FILE` 改：

```json
{
  "dbDriver": "sqlite",
  "dbFile": "data/plugim.db",
  "logDir": "logs"
}
```

由安装向导写入。`savedb` 这一步会先测连接，通过后写入文件并自动重启进程。手工改过之后重启生效。

## .env 模板

仓库根目录的 `.env.example` 就是模板，里面的默认值和代码一致，复制成 `.env` 再改：

```bash
cp .env.example .env
```
