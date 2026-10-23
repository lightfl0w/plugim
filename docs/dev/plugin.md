# 插件模型

前端用 `@plugim/core` 的 `Context` 装配界面与客户端状态；后端是 Rust 里一组按 RPC 方法名注册的 handler 模块，两种模型都强调「声明依赖、各自启停」。

## 前端插件

一个插件就是四段声明加一个 `apply`：

```ts
interface Plugin {
    name: string;
    description?: string;
    provides?: string[];
    inject?: string[];
    apply(ctx: Context): Promise<Dispose | undefined>;
}
```

`provides` 声明这个插件提供哪些服务，`inject` 声明启动前要等哪些服务，`apply` 在依赖就绪后执行一次，返回的 `Dispose` 在停用或退出时调用。

## 服务

服务是一个带名字的对象，`provide` 注册，`get` 取用：

```ts
ctx.provide("clock", { now: () => Date.now() });
const clock = ctx.get<{ now: () => number }>("clock");
```

几条要记的规则：

- 一个服务名必须被某个插件的 `provides` 声明过才算存在。漏了声明，别处 `get` 就抛 `service not found`。
- `inject` 里的服务在 `apply` 之前一定就绪，`apply` 里可以放心 `get`。
- 不要 `inject` 自己 `provides` 的服务，那会等自己，插件永远起不来。
- 两个插件声明同名服务时，后 `provide` 的覆盖先前的。

## 事件

`emit` 只发给当前已注册的监听者，不缓冲，没人听就丢掉：

```ts
let lastSession = "general";
const off = ctx.on("ui:chat:open", (payload) => {
    lastSession = (payload as { session: string }).session;
});
ctx.emit("ui:chat:open", { session: "general" });
off();
```

跨组件的共享状态不要只靠事件传。事件在监听者注册之前发出就永久丢失，React 里兄弟节点的 effect 顺序也没有保证。这类状态放模块级存储，用 `useSyncExternalStore` 订阅，界面一节有例子。

## 启动与停用

`ctx.plugin(p)` 只登记，`ctx.start()` 统一启动。启动时先等 `inject` 再调 `apply`，所以登记顺序不影响依赖关系。状态有 `enabled`、`started`、`failed`、`disabled`、`stopped` 五种，`ctx.list()` 可查，插件管理页就是它的界面。

- `apply` 抛错只把当前插件标记成 `failed`，别的插件照常启动。
- `ctx.disable(name)` 连同依赖它的插件一起停，`ctx.enable(name)` 等依赖都可用时再启动。
- `apply` 里注册的监听、定时器、连接都要在 `Dispose` 里清理，`ctx.stop()` 按登记的反序调用。

## 写一个后端 handler

后端在 `apps/server/src/plugins/` 下，一个模块一组方法。下面这个模块加一条 RPC：

```rust
use serde_json::{json, Value};

use crate::plugins::auth::require_user;
use crate::state::{handler, Registry};

pub fn register(registry: &mut Registry) {
    registry.add(
        "greet.hello",
        handler(|_state, conn, _params| async move {
            let me = require_user(&conn)?;
            Ok(json!({ "message": format!("你好，{}", me.username) }))
        }),
    );
}
```

handler 的签名是 `Fn(SharedState, Conn, Value) -> impl Future<Output = Result<Value, String>>`，用 `state::{handler, Registry}` 里的 `handler()` 包一层就能直接用 `async` 块：

- `params` 是前端传来的 JSON 对象，取值与范围校验在 handler 里自己做。
- `conn.user` 是 `Option<AuthUser>`，登录态由网关在连接建立时校验 token 得出，前端伪造不了身份。要登录态的用 `require_user(&conn)?`。
- 返回的 `Err(String)` 会变成 `rpc:err` 的 `message`，`Ok(Value)` 作为 `rpc:ok` 的 result。
- 参数与返回值的类型定义放在 `@plugim/protocol`，前端 import 同一份。

推事件用 `state.hub.emit_to_user(user_id, name, payload).await`、`emit_to_users(&ids, ..)` 或 `broadcast(name, payload).await`。事件名取协议里的 `ServerEventName`，前端收到的是 `server:<name>` 的 Context 事件，由前端 connection 插件转发。

发消息不要直接调 hub：一律走 `services::send_to(state, &user, session, payload)`，它负责会话键推导、成员校验、seq 分配、未读与离线推送。

## 装进 plugim

1. 把上面的代码存成 `apps/server/src/plugins/greet.rs`
2. 在 `src/plugins/mod.rs` 里加 `pub mod greet;`，并在 `install()` 里调 `greet::register(registry);`
3. 冒烟脚本里补一条用例

跑起来验证：

```sh
pnpm dev:server
pnpm smoke          # SQLite
pnpm smoke:pg       # PostgreSQL
```

服务端没有插件管理页，方法是否注册上看启动日志。不想写前端时，浏览器控制台就能试这条 RPC：

```js
await window.__ctx.get("rpc").call("greet.hello", {})
```

## 加一张表

建表语句在 `apps/server/src/store.rs`，`DDL` 是 SQLite、`PG_DDL` 是 PostgreSQL，加表时两边都写，并且只用一份能在两种库上跑的 SQL：

- 布尔列两边都存 `BIGINT 0/1`，不要用 PG 原生 `BOOLEAN`，否则所有 `VALUES (..., 0, ...)` 直接报类型不匹配
- 时间戳统一是整数毫秒，用 `BIGINT` 而不是 `INTEGER`（`INTEGER` 存不下毫秒时间戳）
- 占位符一律是 `$N`（SQLite 驱动也认），动态拼 `IN` 列表时按 `binds.len() + 1` 现算编号
- 避开 SQLite 专有写法：两参 `max(a, b)`、`date(ms, 'unixepoch')`、未加引号的驼峰别名（PG 会转成小写）、`INSERT OR REPLACE`

取值统一走 `RowExt`（`get_str` / `get_i64` / `get_bool` / `get_opt_str` …），它把两种驱动的类型差异吃掉。

## 协议

一个连接上跑四种帧：`event`、`rpc`、`rpc:ok`、`rpc:err`，定义在 `packages/protocol/src/index.ts`。消息、群组、通话的数据结构，以及每条 RPC 的参数与返回值类型都在这个包里，前后端各自 import。改协议要两端同时改，类型对不上编译就过不了。
