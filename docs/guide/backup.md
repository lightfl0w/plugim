# 备份与升级

## 备份

### SQLite

所有数据都在一个文件里（默认 `data/plugim.db`，以安装向导里实际填的为准）。热备份用 sqlite3 的 backup API，不要直接拷正在写的文件：

```bash
sqlite3 /opt/plugim/data/plugim.db ".backup '/backup/plugim-$(date +%F).db'"
```

放进 crontab 每天跑，保留 14 天：

```text
10 3 * * * sqlite3 /opt/plugim/data/plugim.db ".backup '/backup/plugim-$(date +\%F).db'" && find /backup -name 'plugim-*.db' -mtime +14 -delete
```

### PostgreSQL

```bash
pg_dump "postgres://user:pass@host:5432/plugim" -Fc -f /backup/plugim-$(date +%F).dump
```

恢复：

```bash
pg_restore -d "postgres://user:pass@host:5432/plugim" --clean --if-exists /backup/plugim-YYYY-MM-DD.dump
```

### 需要留存的配置文件

| 文件 | 内容 |
| --- | --- |
| `.env` | JWT 密钥、注册策略、媒体存储、STUN/TURN |
| `data/install.json` | 数据库与日志目录的选择 |
| `data/uploads` | 媒体文件（本地磁盘存储时），默认在进程工作目录下 |

::: warning
`PLUGIM_JWT_SECRET` 丢了只是已登录的会话失效，重新登录即可；但泄露它等于任何人都能伪造任意用户，备份包按机密对待。
:::

## 控制数据体积

媒体文件默认落在 `data/uploads`，消息表里只存路径，所以体积增长主要看这个目录和消息表两头。

1. 后台管理的系统设置页可以设消息保留天数（比如 90），过期清理任务每天自动删过期消息，也会顺手删掉不再被引用的媒体文件。
2. 定时任务页能把清理任务停用、改周期或立刻执行；孤儿文件清理负责回收上传后一直没被引用的文件。
3. 文件管理页能看到文件数量、总占用，也可以逐个下载或删除。
4. SQLite 删掉大量消息后要回收空间：`sqlite3 data/plugim.db "VACUUM;"`
5. 媒体切到 S3 之后，本地目录只剩切过去之前的历史文件，备份策略跟着对象存储走。

## 升级

```bash
cd /opt/plugim
sqlite3 data/plugim.db ".backup '/backup/plugim-pre-upgrade.db'"
git pull
pnpm install
pnpm build
sudo systemctl restart plugim
curl -s http://localhost:3000/version
```

- 表结构启动时自动补齐，不用手工迁移。
- 回滚就是 checkout 旧版本、重新 build、重启；新版本动过表结构的话，回滚前先用升级前的备份恢复数据库。
- 重启期间 WebSocket 客户端会自动重连。

## 换端口或换机器

- 换端口：改 `PORT` 重启，反向代理的上游同步改。
- 换机器：目录（`node_modules` 可以重装）、数据库文件、`.env`、`data/install.json` 拷过去，`pnpm install && pnpm build && pnpm start` 就能跑起来。数据库文件位置变了的话，改 `data/install.json` 里的 `dbFile`。
