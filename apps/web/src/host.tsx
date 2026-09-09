import type { Context, PluginInfo } from "@plugim/core";
import { ArrowLeftIcon, CircleAlertIcon, PuzzleIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import {
    BrowserRouter,
    Link,
    Navigate,
    NavLink,
    Route,
    Routes,
    useNavigate,
} from "react-router-dom";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";
import { saveDisabledPlugins } from "./plugins/registry";
import type { UiService, UiSlot } from "./plugins/ui";

interface SlotEntry {
    id: number;
    component: FC;
    order: number;
}

const bumpReducer = (count: number) => count + 1;

export const mountHost = (ctx: Context): void => {
    const slots = new Map<UiSlot, SlotEntry[]>();
    const routes = new Map<string, FC>();
    const listeners = new Set<() => void>();
    let seq = 0;

    const notify = () => {
        for (const cb of listeners) cb();
    };

    const subscribe = (cb: () => void) => {
        listeners.add(cb);
        return () => {
            listeners.delete(cb);
        };
    };

    const Slot = ({
        slot,
        className,
    }: {
        slot: UiSlot;
        className?: string;
    }) => {
        const [, bump] = useReducer(bumpReducer, 0);
        useEffect(() => subscribe(bump), []);
        const items = slots.get(slot) ?? [];
        return (
            <div className={className}>
                {items.map(({ id, component: Item }) => (
                    <Item key={id} />
                ))}
            </div>
        );
    };

    ctx.provide<UiService>("ui", {
        Slot,
        register(slot, component, order = 0) {
            const id = ++seq;
            const list = slots.get(slot) ?? [];
            list.push({ id, component, order });
            list.sort((a, b) => a.order - b.order);
            slots.set(slot, list);
            notify();
            return () => {
                slots.set(
                    slot,
                    (slots.get(slot) ?? []).filter((entry) => entry.id !== id),
                );
                notify();
            };
        },
        registerRoute(path, component) {
            routes.set(path, component);
            notify();
            return () => {
                routes.delete(path);
                notify();
            };
        },
    });

    const persist = () => {
        saveDisabledPlugins(
            ctx
                .list()
                .filter((p) => p.state === "disabled")
                .map((p) => p.name),
        );
    };
    ctx.onPluginsChange(persist);

    const stateBadge = (info: PluginInfo) => {
        if (info.state === "failed") {
            return (
                <Badge variant="destructive" className="gap-1">
                    <CircleAlertIcon className="size-3" />
                    启动失败
                </Badge>
            );
        }
        return null;
    };

    const PluginsPage = () => {
        const [, bump] = useReducer(bumpReducer, 0);
        const navigate = useNavigate();

        useEffect(() => {
            const dispose = ctx.onPluginsChange(bump);
            return () => {
                void dispose();
            };
        }, []);

        const plugins = ctx.list();

        const toggle = (info: PluginInfo) => {
            if (info.state === "disabled" || info.state === "failed") {
                void ctx.enable(info.name).then(bump);
            } else {
                void ctx.disable(info.name).then(bump);
            }
        };

        return (
            <div className="flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="返回"
                        onClick={() => void navigate(-1)}
                    >
                        <ArrowLeftIcon />
                    </Button>
                    <p className="text-sm font-semibold">插件</p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <p className="px-2 pb-2 text-xs font-semibold text-muted-foreground">
                        系统与所有会话共用 · {plugins.length} 个
                    </p>
                    <div className="flex flex-col gap-1">
                        {plugins.map((info) => (
                            <div
                                key={info.name}
                                className="flex items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-accent/60"
                            >
                                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                                    <PuzzleIcon className="size-4 text-muted-foreground" />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium">
                                            {info.name}
                                        </p>
                                        {stateBadge(info)}
                                    </div>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {info.description ?? "—"}
                                    </p>
                                </div>
                                <Switch
                                    checked={info.state !== "disabled"}
                                    onToggle={() => toggle(info)}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    };

    const NoRoute = () => (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <PuzzleIcon className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">此页面没有可用的界面插件</p>
            <p className="max-w-sm text-xs text-muted-foreground">
                页面由界面插件提供,相关插件可能已停用或尚未安装。
            </p>
            <Link
                to="/settings/plugins"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
                打开插件管理
            </Link>
        </div>
    );

    const Root = () =>
        routes.has("/chat") ? <Navigate to="/chat" replace /> : <NoRoute />;

    const HostLayout = () => {
        const [, bump] = useReducer(bumpReducer, 0);
        useEffect(() => subscribe(bump), []);
        return (
            <div className="flex h-full">
                <aside className="flex w-16 shrink-0 flex-col items-center border-r border-border bg-muted/40 py-3">
                    <Slot
                        slot="nav"
                        className="flex min-h-0 flex-1 flex-col items-center gap-2"
                    />
                    <NavLink
                        to="/settings/plugins"
                        title="插件"
                        className={({ isActive }) =>
                            cn(
                                "mt-2 flex size-10 items-center justify-center rounded-lg",
                                isActive
                                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                            )
                        }
                    >
                        <PuzzleIcon className="size-5" />
                    </NavLink>
                </aside>
                <main className="flex min-w-0 flex-1 flex-col">
                    <Routes>
                        <Route
                            path="/settings/plugins"
                            element={<PluginsPage />}
                        />
                        {[...routes.entries()].map(([path, component]) => {
                            const Page = component;
                            return (
                                <Route
                                    key={path}
                                    path={path}
                                    element={<Page />}
                                />
                            );
                        })}
                        <Route path="/" element={<Root />} />
                        <Route path="*" element={<NoRoute />} />
                    </Routes>
                </main>
            </div>
        );
    };

    const root = document.getElementById("root");
    if (!root) throw new Error("missing #root element");
    createRoot(root).render(
        <BrowserRouter>
            <HostLayout />
        </BrowserRouter>,
    );
};
