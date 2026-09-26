# 插件模型

后端和前端共用 `@plugim/core` 的 `Context`。一个插件就是四段声明加一个 `apply`：

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

## 写一个后端插件

服务端插件都在 `apps/server/src/plugins/` 下，一个插件一个文件。下面这个插件提供一个服务和一条 RPC：

```ts
import type { Plugin } from "@plugim/core";
import type { ConnInfo, GatewayService } from "../types";

export const greetPlugin: Plugin = {
    name: "greet",
    description: "问候",
    provides: ["greet"],
    inject: ["gateway"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");

        const hello = (username: string) => `你好，${username}`;

        gateway.rpc("greet.hello", (_params, conn: ConnInfo) => {
            if (!conn.user) throw new Error("未登录或登录已过期");
            return { message: hello(conn.user.username) };
        });

        ctx.provide("greet", { hello });
        return undefined;
    },
};
```

RPC 处理器的签名是 `(params, conn)`：

- `params` 是前端传来的对象，服务端自己做类型校验和取范围限制。
- `conn.user` 是 `AuthUser | null`，登录态由网关在连接建立时校验 token 得出，前端伪造不了身份。
- 处理器抛出的错误会变成 `rpc:err` 回给前端，`message` 就是错误文案。
- 返回值作为 `rpc:ok` 的 result 发回，参数与返回值的类型定义放在 `@plugim/protocol`。

推事件用 `gateway.emitToUser(userId, name, payload)` 或 `gateway.broadcast(name, payload)`，前者发给这个用户的所有连接，后者发给所有连接。事件名取协议里的 `ServerEventName`，前端收到的是 `server:<name>` 的 Context 事件，由前端 connection 插件转发。

## 装进 plugim

把上面的代码存成 `apps/server/src/plugins/greet.ts`，再在 `apps/server/src/index.ts` 里登记：

```ts
import { greetPlugin } from "./plugins/greet";

ctx.plugin(greetPlugin);
```

登记写在文件哪个位置都行，每行只把插件记进清单，`ctx.start()` 时统一按 `inject` 算出启动顺序。

跑起来验证：

```sh
pnpm dev:server
```

`dev:server` 是 `tsx watch`，存盘自动重启；生产上是 `pnpm build` 之后 `pnpm start`。服务端没有插件管理页，插件是否起来看启动日志。

不想写前端时，浏览器控制台就能试这条 RPC，前端的 Context 挂在 `window.__ctx` 上：

```js
await window.__ctx.get("rpc").call("greet.hello", {})
```

服务端侧的用例写法见[测试与校验](/dev/test)。

## 加一张表

存储集中在 `apps/server/src/plugins/storage.ts`，sqlite 与 postgres 各一套：

- 建表语句是 `CREATE_SQLITE` 与 `CREATE_PG` 两段常量，加表时两边都写。时间戳在 sqlite 里是整数毫秒，在 pg 里是 `timestamptz`。
- drizzle 表定义同样两份，`sqliteTable` 与 `pgTable` 各一份，供查询用。
- Store 的接口声明在 `apps/server/src/types.ts`。插件之间只依赖接口，不关心底层驱动，测试里也常替换成假实现。

## 协议

一个连接上跑四种帧：`event`、`rpc`、`rpc:ok`、`rpc:err`，定义在 `packages/protocol/src/index.ts`。消息、群组、通话的数据结构，以及每条 RPC 的参数与返回值类型都在这个包里，前后端各自 import。改协议要两端同时改，类型对不上编译就过不了。
