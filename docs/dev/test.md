# 测试与校验

## 命令

从仓库根跑：

```bash
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm test` 按包依次跑 vitest：core 测 Context 的依赖与生命周期，server 测 RPC 与存储，web 测前端里的纯服务。单跑一个包用 `pnpm --filter @plugim/server test`。`pnpm typecheck` 是各包的 `tsc --noEmit`，`pnpm lint` 是 Biome，改动提交前三个都跑一遍。

## 服务端测试

`apps/server/test/helpers.ts` 的 `createTestApp()` 起一个真实的 Context：gateway 换成假实现，事件记进数组，其余插件都是真身，SQLite 落在 `mkdtemp` 出来的临时目录，用例之间互不影响。

```ts
const app = await createTestApp({ admins: ["root"] });
const root = await app.register("root");
const bob = await app.register("bob");

await app.call("friend.request", { username: "bob" }, root.user);
expect(app.eventsFor(bob.user.id, "friend:update")).toHaveLength(1);
```

帮手清单：

- `app.call(method, params, user)` 直接调 RPC 处理器，`user` 传 `null` 表示未登录。未知方法会抛 `unknown method`。
- `app.register` 与 `app.login` 建号并返回 `{ user, token }`，默认密码 `Passw0rd!`。
- `app.eventsFor(userId, name)` 取发给某个用户的事件，`name` 省略则取全部。
- `app.setOnline(user)` 与 `app.goOffline(userId)` 控制在线状态，用来测离线推送、通话清理这类分支。
- `uploadFile(app, token, name, mime, bytes)` 走真实的 `/upload` 路由。

完整用例可以看 `apps/server/test/group-files.test.ts`：建群、上传、把文件加进群、断言成员收到 `group:update`、断言陌生人被拒。

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
