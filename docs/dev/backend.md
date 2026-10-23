# 后端结构

后端是一个 Rust 单进程二进制：Axum 0.8 提供 HTTP 与 WebSocket，sqlx `AnyPool` 同时支持 SQLite 与 PostgreSQL，
JWT / argon2 / TOTP / Web Push / S3 SigV4 全部手写，运行时不依赖 Node。

协议与前端共用 `@plugim/protocol`：一个连接上跑 `event`、`rpc`、`rpc:ok`、`rpc:err` 四种帧，
RPC 方法名与参数结构一一对应，前端不需要知道后端是哪种语言。

## 当前状态

| 指标 | 数值 |
| --- | --- |
| RPC 方法 | 179 个，无多余方法 |
| 端到端冒烟 | SQLite 315 项、PostgreSQL 317 项，全通过（`scripts/smoke.mjs`） |
| 数据库驱动 | SQLite（`sqlite://`，WAL + `busy_timeout`）与 PostgreSQL，同一套手写 SQL |
| 前端产物 | 由后端直接托管，单端口运行 |

## 目录

```
apps/server/
  Cargo.toml
  src/
    main.rs        路由 + WebSocket 循环 + 静态托管 + 优雅关闭
    config.rs      配置解析（install.json > 环境变量 > .env）
    store.rs       全部 SQL、建表（DDL / PG_DDL）、RowExt 兼容层
    state.rs       AppState / Registry / Conn / dispatch
    hub.rs         连接表、广播、踢下线、掉线钩子
    services.rs    会话键推导、好友/群校验、发送与广播
    util.rs        JWT、argon2、TOTP、时间与参数工具
    metrics.rs     Prometheus 指标与堆统计
    scheduler.rs   定时任务、留存清理、数据库备份
    logger.rs      按天/按体积轮转的文件日志
    linkpreview.rs 链接预览抓取与 SSRF 防护
    plugins/       按模块注册 RPC（含 push.rs、s3.rs）
```

## 模块覆盖

| 模块 | 文件 | 覆盖内容 |
| --- | --- | --- |
| 配置 | `src/config.rs` | `install.json` → 环境变量 → `.env` → 默认值；JWT 密文持久化到 `data/.jwt-secret`；ICE 服务器列表；`install.json` 原子读写 |
| 数据库 | `src/store.rs` | 建表、用户、好友、群组、消息、回执、会话元数据、媒体、群文件、朋友圈、红包、转账、AA、机器人应用与订阅、审计、部门、设置 |
| 网关 | `src/main.rs` | `/ws`、`/rpc/{method}`、`/health`、`/version`、`/metrics`、`/metrics.json`、`/site/meta`、`/auth/register-policy`、`/upload`、`/files/{key}`、`/open/message`、`/open/messages`、`/open/whoami`、静态资源托管；单连接 6s 处理超时与慢调用日志 |
| 鉴权 | `src/plugins/auth.rs` | 注册、登录、改密、会话设备管理、TOTP、`auth.me`、`user.info`、在线状态 |
| 好友 | `src/plugins/friends.rs` | 申请/接受/拒绝/删除/拉黑/备注/星标/分组/搜索（14 个方法） |
| 群组 | `src/plugins/group.rs` | 建群、成员管理、角色、禁言、公告、邀请码、入群审批、精华、转让群主、解散（24 个方法） |
| 群文件 | `src/plugins/group_files.rs` | 列表分页、添加（仅限本人上传）、删除（上传者或群管理）并清理孤立媒体 |
| 消息 | `src/plugins/chat.rs` | 发送、历史、撤回、回应、编辑、搜索、已读回执、会话列表/置顶、增量同步、正在输入、戳一戳、转发 |
| 文件 | `src/plugins/files.rs` | 上传（动态限额、UTF-8 文件名）、鉴权下载、`files.info`、`files.config.get/set/test`（本地与 S3 两种驱动，写入 settings 后即时生效） |
| 机器人 | `src/plugins/bots.rs` | 应用与 Token（`pgm_` + 32 字符、SHA-256 存储）、事件订阅、Webhook 出站投递（5s 超时、3 次重试、失败计数与最近错误）、开放 API `/open/*`；消息、撤回、编辑、已读四类事件已挂接 |
| 音视频 | `src/plugins/screen.rs` | `screen.*` 一对一通话状态机（邀请/接听/拒绝/挂断/信令/超时）、`call.group.*` 群通话房间、掉线清理钩子 |
| 朋友圈 | `src/plugins/moments.rs` | 发布（公开/好友/部分/排除四种可见性）、时间线、空间链接、点赞、评论、删除、转发、未读与已读 |
| 资金 | `src/plugins/funds.rs` | 钱包余额与充值、转账（冻结→收款/退回/过期退款）、红包（均分/拼手气、领取记录）、AA 账单（均分/自定分摊、付款结算、取消、逾期） |
| 后台 | `src/plugins/admin.rs` | 用户/群/消息/文件管理、留存策略、站点信息、注册策略、站点模式、审计、统计与趋势、任务手动执行 |
| 安装器 | `src/plugins/install.rs` | 状态查询、数据库连通性测试（SQLite 试写 / PostgreSQL 建连查询）、写 `install.json` 后自重启、完成初始化（注册策略/邀请码/站点模式上锁） |
| 升级 | `src/plugins/update.rs` | `admin.update.check/status/apply`：远端 git 比对、脏工作区保护、状态文件、后台执行 `scripts/self-update.sh` |
| 通讯录 | `src/plugins/org.rs` | 部门树、企业通讯录、部门增删改移、成员分配、部门群创建与同步 |
| 表情包 | `src/plugins/stickers.rs` | 收藏/列表/移除 |
| 偏好 | `src/plugins/prefs.rs` | 免打扰（时段与免打扰会话） |

资金域的所有余额变动都在 `store.rs` 的事务内完成：转账发起即扣款冻结，收款/退回/过期各自在
同一事务里加回余额；AA 付款在一次事务里扣付款人、加发起人、写流水并推进 `settledAmount`。
冒烟按「扣款 → 收款 → 退款 → 结算」顺序断言每一步的余额，避免只验证返回结构。

机器人域的事件出站是真实投递：冒烟在本地起一个 HTTP 接收端，断言「订阅关闭时不投递」、
「开启后收到 `x-plugim-event` 头」、「`x-plugim-signature` 等于 `sha256(secret + "." + body)`」、
以及负载里的 `event`/`bot`/`at`/`data.message`。

## 基础设施

| 模块 | 文件 | 覆盖内容 |
| --- | --- | --- |
| 指标 | `src/metrics.rs` | `/metrics`（Prometheus 文本）与 `/metrics.json`：uptime、WS 连接数、消息计数、HTTP 请求/错误、事件循环延迟、RSS、堆用量、`plugim_rpc_*`（调用数/错误数/耗时累计/最大耗时/累积直方图）。堆用量由 `#[global_allocator]` 计数得出，不是占位 0 |
| 定时任务 | `src/scheduler.rs` | 三个内置任务（`message-cleanup` / `media-sweep` / `db-backup`），60s tick + 首 tick 5s，按 `intervalMinutes` 与 `lastRun` 判重、`RUNNING` 集合防重入，状态持久化在 `settings.task_state_<name>` |
| 日志轮转 | `src/logger.rs` | `server-YYYY-MM-DD.log` 按天切换、单文件超过 `PLUGIM_LOG_MAX_BYTES`（默认 8 MiB）按 `.N` 切片，同时写 stdout；保留 `PLUGIM_LOG_KEEP_DAYS` 天 / `PLUGIM_LOG_KEEP_FILES` 个 |
| 数据库备份 | `src/scheduler.rs` | SQLite 用 `VACUUM INTO` 热备份成 `plugim-<时间戳>.db`；PostgreSQL 用 `pg_dump --no-owner --no-privileges` 导出 `plugim-<时间戳>.sql`；共用保留策略 `PLUGIM_BACKUP_KEEP`（默认 7，上限 365） |
| Web Push | `src/plugins/push.rs` | RFC 8291 `aes128gcm` 真实加密（P-256 ECDH + HKDF + AES-GCM）与 VAPID ES256 签名；消息、朋友圈互动都触发后台投递，跳过在线用户与免打扰；404/410 自动清理失效订阅 |
| 链接预览 | `src/linkpreview.rs` | 真实抓取 OG/Twitter 卡片：实体解码、相对图片解析、最多 3 次重定向、512 KB 与 5s 上限、600s TTL 缓存；SSRF 防护拦截私网/环回/链路本地与非常规端口，`.resolve()` 固定解析结果防 DNS 重绑定 |
| 全文检索 | `src/store.rs` | FTS5 `tokenize='trigram'` 虚表 + insert/delete/update 三触发器 + 启动回填；关键词 ≥3 字且不含空白走 `MATCH`，否则或 FTS5 不可用时退回 `LIKE ... ESCAPE` |
| S3 驱动 | `src/plugins/s3.rs` | 手写 SigV4（canonical request / string-to-sign / 派生密钥，canonical headers 按字母序），`PutObject`/`GetObject`/`DeleteObject`/`HeadBucket`，支持 path-style 与 virtual-host 两种寻址 |
| PostgreSQL | `src/store.rs` | sqlx `AnyPool` 统一两套驱动，全部 SQL 用 `$N` 占位符、取值走 `RowExt`；`PG_DDL` 把 `INTEGER` 全升 `BIGINT`，布尔列仍存 `BIGINT 0/1` 以保持同一套 SQL |

## 数据库方言约束

只有一份 SQL，就得两边都能跑。已经踩过的坑，加新查询时按这几条检查：

| 约束 | 说明 |
| --- | --- |
| 占位符统一 `$N` | SQLite 驱动也认 `$1`，反过来 PG 不认 `?` |
| 动态 `IN` 列表 | 编号按 `binds.len() + 1` 现算，不要写死 `$1` |
| 布尔列存 `BIGINT 0/1` | PG 原生 `BOOLEAN` 会让所有 `VALUES (..., 0, ...)` 报类型不匹配 |
| 时间戳列用 `BIGINT` | 毫秒时间戳溢出 `INTEGER`（int4） |
| 不用两参 `max(a, b)` | PG 没有这个函数，改 `CASE WHEN` 或 `GREATEST` |
| 不用 `date(ms, 'unixepoch')` | SQLite 专有；按日聚合放回 Rust 用 chrono 做 |
| 别名加引号或全小写 | 未加引号的驼峰别名会被 PG 转成小写，`get("maxSeq")` 取不到 |
| `sum()` 显式 `CAST(... AS BIGINT)` | PG 返回 numeric，直接按 i64 解码会失败 |

## 运行

```bash
pnpm dev:server                 # cargo run
pnpm build && pnpm start        # release 二进制 + 前端产物

pnpm smoke                      # SQLite 冒烟（临时库、PORT=3999）
pnpm smoke:pg                   # PostgreSQL 冒烟（重建 plugim_smoke 库）
BASE=http://127.0.0.1:3999 node scripts/smoke.mjs   # 对已启动实例只跑用例
```

选 PostgreSQL 时在 `install.json` 写 `{"dbDriver":"postgres","databaseUrl":"postgres://user@host:5432/plugim"}`，
或用环境变量 `DATABASE_URL`（优先级低于 install.json）。

## 验证要点

`scripts/smoke.mjs` 覆盖：注册登录、未知方法、匿名拦截、好友全链路、私聊投递与
会话别名、历史/搜索/撤回/编辑/回应、未读数与已读回执、会话置顶、群创建与邀请码入群、
禁言拦截、权限校验、文件上传下载与 UTF-8 文件名、媒体消息校验、增量同步、
设备会话与 TOTP、表情包、免打扰、后台统计/趋势/站点/模式/部门/审计/任务、
群文件全链路、一对一通话（忙线、信令顺序、非法参数、通话摘要）、群通话（邀请/加入/
信令转发/仅发起人可结束）、朋友圈（四种可见性、空间链接、点赞评论、转发、未读/已读）、
资金（充值、转账收款/拒绝退款、红包均分与重复领取、AA 分摊与结算）、
机器人（Token 格式、scope 拦截、订阅校验、开放 API 收发消息、签名投递、撤销后令牌失效）、
安装器（锁定判定、重复初始化拒绝、PostgreSQL 真实连通性测试）、升级（非 git 部署的降级返回、非管理员拒绝）、
存储配置（驱动与限额校验、目录可写探测、非管理员拒绝）。

基础设施部分同样逐项断言，而不是只看返回结构：`/metrics` 的文本含全部指标名且直方图桶单调递增、
`/metrics.json` 的 RPC 耗时与调用数一致；日志文件与备份文件真的落盘且能被读到；Web Push 用 Node 侧
独立实现的 RFC 8291 解密核对明文、用 SPKI 解出 VAPID 公钥验 ES256 签名；S3 mock 重算 canonical
request 校验签名，错误密钥必须被拒；链接预览断言 OG 标签解析、实体解码、相对图片路径补全、重定向跟随
与非 HTML 拒绝、非法 scheme 拒绝；FTS5 走 `MATCH` 分支能被搜索命中，退化为 `LIKE` 时结果一致。

同一套用例对两种驱动都跑，因此 SQL 层的方言差异不会在切换驱动时才暴露。

脚本按 45 次/秒的预算自动节流：服务端对单连接限 60 次/秒，处理过快时不节流会触发
`1008 rate limited` 断连，看起来像「请求无响应」。

## 实现上的取舍

| 位置 | 做法 | 原因 |
| --- | --- | --- |
| RPC 处理超时 | 单条 RPC 超过 6s 返回 `内部超时` | 防止个别慢查询把连接拖住 |
| 慢调用日志 | 超过 `PLUGIM_SLOW_RPC_MS`（默认 1500ms）打 `slow rpc` | 不看监控也能发现退化 |
| 上传体积上限 | 全局 body 上限在启动时从 `upload_limit_mb` 读取 | axum 的 `DefaultBodyLimit` 是路由层配置，改配置后新限额立即作用于 `upload` 校验，整体 body 上限需重启 |
| `PLUGIM_REPO` | 设置后即视为部署根目录，找不到 `.git` 就不再向上搜索 | 便于测试与容器化部署明确指定 |
| `install.savedb` | 写配置后 400ms 自重启，`PLUGIM_NO_RESPAWN=1` 时跳过 | 供冒烟与容器编排控制 |
| `admin.update.apply` | 更新脚本以 `bash` 直接启动，不 `setsid` | 父进程退出后子进程继续 |
| `plugim_rpc_*` 指标 | 直方图桶边界 `5/10/25/50/100/250/500/1000/2500/5000` ms，单个进程最多跟踪 500 个方法 | 避免方法基数爆炸 |
| 趋势统计 | 按日聚合在 Rust 内完成 | PG 的 `date()` 与 SQLite 的 `date(...)` 不通用；只取两列且 `days` 上限 90，开销可忽略 |
| `redpacket.detail` / `records` | 发送人也能查看自己发的红包 | 私聊别名 `p2p:<对方>` 不含发送人，按会话名匹配会误判「你不在该会话中」 |
| 链接预览 | 默认拒绝私网/环回地址，需要时用 `PLUGIM_LINK_ALLOW_PRIVATE=1` 放开 | SSRF 防护 |

## 下一步

1. 用真实对象存储（非 mock）跑一遍 S3 全链路，确认大文件与特殊字符 key。
2. 补一份 SQLite → PostgreSQL 的数据迁移脚本，方便已有部署换库。
3. 在 CI 里同时跑两套冒烟（SQLite + 起了服务的 PostgreSQL），防止新 SQL 引入方言回退。
