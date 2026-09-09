import type { Plugin, PluginInfo } from "@plugim/core";
import {
    ArrowLeftIcon,
    CircleAlertIcon,
    LockIcon,
    PuzzleIcon,
} from "lucide-react";
import { useEffect, useReducer } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import { saveDisabledPlugins } from "./registry";
import type { UiService } from "./shell";

const bumpReducer = (count: number) => count + 1;

const stateBadge = (info: PluginInfo) => {
    if (info.state === "failed") {
        return (
            <Badge variant="destructive" className="gap-1">
                <CircleAlertIcon className="size-3" />
                启动失败
            </Badge>
        );
    }
    if (info.core) {
        return (
            <Badge variant="outline" className="gap-1">
                <LockIcon className="size-3" />
                核心
            </Badge>
        );
    }
    return null;
};

export const uiPluginsPlugin: Plugin = {
    name: "ui-plugins",
    description: "插件清单与启停管理",
    inject: ["ui"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");

        const persist = () => {
            saveDisabledPlugins(
                ctx
                    .list()
                    .filter((p) => p.state === "disabled")
                    .map((p) => p.name),
            );
        };
        const disposePersist = ctx.onPluginsChange(persist);

        const NavEntry = () => (
            <NavLink
                to="/settings/plugins"
                title="插件"
                className={({ isActive }) =>
                    cn(
                        "flex size-10 items-center justify-center rounded-lg",
                        isActive
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )
                }
            >
                <PuzzleIcon className="size-5" />
            </NavLink>
        );

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
            const count = plugins.length;

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
                            系统与所有会话共用 · {count} 个
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
                                    {info.core ? (
                                        <span
                                            title="核心插件不可停用"
                                            className="text-muted-foreground"
                                        >
                                            <LockIcon className="size-4" />
                                        </span>
                                    ) : (
                                        <Switch
                                            checked={info.state !== "disabled"}
                                            onToggle={() => toggle(info)}
                                        />
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            );
        };

        const unregisterNav = ui.register("nav", NavEntry, 10);
        const unregisterPage = ui.register("settings", PluginsPage);
        return () => {
            unregisterNav();
            unregisterPage();
            disposePersist();
        };
    },
};
