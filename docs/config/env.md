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
| `PLUGIM_ADMINS` | `admin` | 引导管理员用户名，逗号分隔；这些用户名注册时自动获得管理员 |
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
