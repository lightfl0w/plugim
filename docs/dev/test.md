# 测试与校验

## 命令

从仓库根跑：

```bash
pnpm typecheck     # 前端 tsc --noEmit + cargo check
pnpm test          # 前端与 core 的 vitest
pnpm lint          # Biome
pnpm smoke         # 后端端到端冒烟（SQLite）
pnpm smoke:pg      # 后端端到端冒烟（PostgreSQL）
```

改动提交前建议全跑一遍。后端没有 Rust 单元测试，行为全部压在冒烟脚本上 —— 它起的是真实服务进程、真实数据库、真实 WebSocket，比重型 mock 更贴近线上。

## 后端冒烟

`scripts/smoke.mjs` 是唯一的用例文件，`scripts/smoke-sqlite.sh` 与 `scripts/smoke-pg.sh` 负责准备环境：

```bash
bash scripts/smoke-sqlite.sh    # 临时目录 + 临时库，PORT=3999
bash scripts/smoke-pg.sh        # 重建 plugim_smoke 库后跑同一套用例
```

两个脚本都会把临时目录、端口、`install.json` 传给 `smoke.mjs`，所以切换驱动时方言问题会立刻暴露 —— 目前 SQLite 315 项、PostgreSQL 317 项（多两条 PG 专用用例）。

脚本自带的几个 mock 服务让外部依赖可控，不联网也能跑：

| mock | 用途 |
| --- | --- |
| `/hook` | 机器人 webhook 回调 |
| `/push` | Web Push 接收端，用独立实现解 RFC 8291 载荷、验 VAPID 签名 |
| `/og`、`/og-redirect`、`/og-plain` | 链接预览抓取（含重定向与非 HTML 响应） |
| S3 mock | 完整重算 SigV4 签名，验密钥与 canonical headers |

写新用例时照抄 `check(name, cond, detail)` 的形状，断言文案用英文短句，`detail` 里塞原始返回，失败时会直接打出来：

```js
const res = await alice.rpc("greet.hello", {});
check("greet returns message", res.message === "你好，alice", res);
```

`PLUGIM_SMOKE_PG_URL` 存在时脚本才会跑 PostgreSQL 专用断言（`install.testdb` 的 postgres 分支），SQLite 模式下自动跳过。

## 前端测试

vitest 跑在 node 下，没有 DOM。需要 IndexedDB 的用例在文件顶部写 `import "fake-indexeddb/auto"`。常规写法是起一个 Context、登记单个插件、取服务断言，插件依赖的外部服务用 `ctx.provide` 塞假实现：

```ts
const ctx = new Context();
ctx.provide<RpcService>("rpc", {
    call: async () => ["alice"],
    status: () => "open",
    onStatus: () => () => undefined,
});
ctx.plugin(presencePlugin);
await ctx.start();
const presence = ctx.get<PresenceService>("presence");
```

服务端推来的事件用 `ctx.emit("server:presence:update", { username: "bob", online: true })` 模拟，这也是前端唯一接触事件的地方。参照 `apps/web/test/presence.test.ts`。

`@plugim/core` 自己有一套用例，测的是 Context 的依赖等待、启停顺序与失败隔离，改插件运行时先跑它。
