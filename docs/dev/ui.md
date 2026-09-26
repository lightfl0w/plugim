# 界面插件

前端从 `apps/web/src/main.tsx` 启动：建一个 `Context`，`mountHost(ctx)` 装配界面并注册 `ui` 服务，然后登记 `apps/web/src/plugins/registry.ts` 里的 `globalPlugins`，最后 `ctx.start()`。

`mountHost` 渲染的骨架是 `apps/web/src/host.tsx` 里的 `HostLayout`：一条导航栏加一个 `<Routes>`。导航栏在宽屏是左侧竖栏，窄屏落到底部。`/settings/plugins` 是插件管理页，每个插件一行，可以启停，定义了设置项的还能跳进设置页。`/install` 这类无壳路由和带 `popup=1` 的独立小窗不渲染导航栏。

## ui 服务

```ts
interface UiService {
    Slot: FC<{ slot: UiSlot; className?: string }>;
    register(slot: UiSlot, component: FC, order?: number): () => void;
    registerRoute(path: string, component: FC): () => void;
}
```

槽位一共九个：

| 槽位 | 位置 |
|------|------|
| `auth` | 登录注册页的卡片区 |
| `nav` | 导航栏 |
| `sidebar` | 会话列表栏 |
| `header` | 会话顶栏 |
| `messages` | 消息流 |
| `composer` | 输入区 |
| `friends-list` | 好友页左栏 |
| `friends-detail` | 好友页右栏 |
| `overlay` | 全局浮层，盖在页面之上 |

两个 register 都返回取消函数，插件退出时调用。同一个槽位挂多个组件时按 `order` 升序渲染，默认 0，当前仓库里用到的有 5 到 90。

## 写一个界面段

界面全部在 `apps/web/src/plugins/ui-views.tsx` 这一个插件里，每个段是一个 `(ctx) => Dispose` 的 setup 函数，在 `SECTIONS` 里按顺序登记。段里抛错只记日志，其余段照常启动。

新增一个 `ui-greet.tsx`：

```tsx
import type { Context } from "@plugim/core";
import { useEffect, useState } from "react";
import type { RpcService } from "./connection";
import type { UiService } from "./ui-types";

const GreetBadge = ({ ctx }: { ctx: Context }) => {
    const [text, setText] = useState("未连接");
    useEffect(() => {
        const rpc = ctx.get<RpcService>("rpc");
        void rpc
            .call("greet.hello", {})
            .then((result) => {
                setText((result as { message: string }).message);
            })
            .catch(() => setText("未连接"));
    }, [ctx]);
    return <span className="text-xs text-muted-foreground">{text}</span>;
};

export const uiGreetSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    return ui.register("header", () => <GreetBadge ctx={ctx} />);
};
```

然后在 `ui-views.tsx` 的 `SECTIONS` 里加一行：

```ts
{ name: "问候", setup: uiGreetSetup },
```

需要整页时用 `ui.registerRoute("/greet", GreetPage)`，路由直接进 host 的 `<Routes>`。

## 装成独立插件

写进 `SECTIONS` 的段跟着 `views` 一起启停，插件管理页里只有 `views` 一行。要让新功能自己占一行、能单独停用，就把它做成独立插件：把 `GreetBadge` 连同 import 挪进 `apps/web/src/plugins/ui-greet.tsx`，文件末尾补一个插件对象。

```tsx
import type { Plugin } from "@plugim/core";
import type { UiService } from "./ui-types";

export const greetPlugin: Plugin = {
    name: "greet",
    description: "问候徽标",
    inject: ["ui", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const unregister = ui.register("header", () => (
            <GreetBadge ctx={ctx} />
        ));
        return unregister;
    },
};
```

再在 `apps/web/src/plugins/registry.ts` 的 `globalPlugins` 里加一行 `greetPlugin,`。`pnpm dev:web` 是 Vite 热更新，保存后徽标就挂上去了，插件名 `greet` 也会出现在 `/settings/plugins`，停用与启用都在那一页。

- 停用名单存在 localStorage 的 `plugim_disabled_plugins`，刷新浏览器后依然生效。
- `inject` 里的服务没人提供时插件会一直等，界面照常渲染，只是没有这个徽标。
- 插件要带设置项，就在 `apply` 里调 `settings.define("greet", ...)`，见下节。

## 状态

界面组件不要靠事件拿共享状态。事件没有缓冲，注册晚了就收不到，跨插件的会话状态在 `ui-shared.ts` 里用模块级存储加 `useSyncExternalStore` 暴露：`useChatTarget` 与 `useShellPane` 是两个现成例子，`openChat` 负责写入状态并广播 `ui:chat:open` 给其他插件。新写的共享状态照这个模式来。

## 插件设置

`settings` 服务给插件生成设置界面，插件只声明字段：

```ts
settings.define("greet", "问候", [
    { key: "enabled", label: "显示问候", kind: "boolean", default: true },
    { key: "size", label: "字号", kind: "number", default: 12, min: 10, max: 24, step: 1 },
    {
        key: "tone",
        label: "语气",
        kind: "select",
        default: "warm",
        options: [
            { value: "warm", label: "热络" },
            { value: "plain", label: "平常" },
        ],
    },
]);
```

字段类型有 `color`、`number`、`boolean`、`select` 四种。读写用 `get`、`set`、`reset`、`resetPlugin`、`isDefault`，订阅用 `onChange`，`"*"` 是通配。

组的名字要等于插件名，插件管理页才会给它显示设置按钮，点进去是 `/settings/<插件名>`，页面由 `ui-settings` 统一渲染。设置存在 localStorage 的 `plugim_plugin_settings` 键下，按插件分组。

## 样式与窄屏

Tailwind v4，色板变量在 `index.css` 里用 OKLCH 定义，views 的外观设置会把改过的颜色写回同名 CSS 变量。断点是 `md`，768px 以下按手机处理：

- 根节点用 `h-dvh`，底部导航栏留 `env(safe-area-inset-bottom)`。
- 面板和对话框在窄屏开整屏，宽屏回到居中弹层。
- 触摸设备没有右键，长按代替。`longPressMenu` 封装了 480ms 判定、滑动取消，以及长按之后吞掉那次 click 的逻辑。

## 独立小窗

`/chat?session=<会话>&popup=1` 渲染无壳界面：没有导航栏，没有会话列表，标题跟会话名同步。`openDetachedChat(session)` 用固定的窗口名打开，同一个会话重复打开会复用已开的窗口，不同会话才开新窗。
