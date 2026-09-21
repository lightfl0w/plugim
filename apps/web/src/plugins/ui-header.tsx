import type { Plugin } from "@plugim/core";
import type { GroupInfo } from "@plugim/protocol";
import { SearchIcon, SettingsIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnStatus, RpcService } from "./connection";
import type { PresenceService } from "./presence";
import type { UiService } from "./ui";

const statusColor: Record<ConnStatus, string> = {
    open: "bg-emerald-500",
    connecting: "bg-amber-400",
    closed: "bg-red-500",
};

const statusText: Record<ConnStatus, string> = {
    open: "已连接",
    connecting: "连接中",
    closed: "已断开",
};

export const uiHeaderPlugin: Plugin = {
    name: "ui-header",
    description: "聊天顶部栏(标题 / 群信息 / 在线状态 / 记录搜索)",
    inject: ["ui", "rpc", "presence"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");
        const presence = ctx.get<PresenceService>("presence");

        const Header = () => {
            const [status, setStatus] = useState(rpc.status());
            const [title, setTitle] = useState("");
            const [session, setSession] = useState("");
            const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
            const [searchOpen, setSearchOpen] = useState(false);
            const [query, setQuery] = useState("");
            const inputRef = useRef<HTMLInputElement>(null);
            const debounceRef = useRef<
                ReturnType<typeof setTimeout> | undefined
            >(undefined);
            const [, setPresenceTick] = useState(0);
            useEffect(
                () => presence.onChange(() => setPresenceTick((t) => t + 1)),
                [],
            );

            useEffect(() => rpc.onStatus(setStatus), []);

            useEffect(() => {
                const disposeOpen = ctx.on("ui:chat:open", (payload) => {
                    const data = payload as {
                        title?: string;
                        session?: string;
                    };
                    setTitle(data.title ?? "会话");
                    setSession(data.session ?? "");
                    setSearchOpen(false);
                    setQuery("");
                    ctx.emit("ui:chat:search", { query: "" });
                });
                const disposeClear = ctx.on("ui:chat:search:clear", () => {
                    setSearchOpen(false);
                    setQuery("");
                });
                return () => {
                    void disposeOpen();
                    void disposeClear();
                };
            }, []);

            useEffect(() => {
                void status;
                if (!session.startsWith("g:")) {
                    setGroupInfo(null);
                    return;
                }
                void rpc
                    .call("group.info", { groupId: session.slice(2) })
                    .then((result) => setGroupInfo(result as GroupInfo))
                    .catch(() => setGroupInfo(null));
            }, [session, status]);

            const pushQuery = (next: string) => {
                setQuery(next);
                clearTimeout(debounceRef.current);
                debounceRef.current = setTimeout(() => {
                    ctx.emit("ui:chat:search", { query: next });
                }, 250);
            };

            const peerName = session.startsWith("p2p:")
                ? session.slice(4)
                : null;

            return (
                <div className="flex w-full items-center gap-2">
                    <p className="text-sm font-semibold">
                        {title || "选择会话"}
                    </p>
                    {groupInfo ? (
                        <span className="text-xs text-muted-foreground">
                            ({groupInfo.memberCount})
                        </span>
                    ) : null}
                    {peerName ? (
                        <span
                            className={
                                presence.isOnline(peerName)
                                    ? "text-xs text-emerald-600"
                                    : "text-xs text-muted-foreground"
                            }
                        >
                            {presence.isOnline(peerName) ? "在线" : "离线"}
                        </span>
                    ) : null}
                    <span
                        title={statusText[status]}
                        className={`size-2 shrink-0 rounded-full ${statusColor[status]}`}
                    />
                    <div className="ml-auto flex items-center gap-1">
                        {groupInfo ? (
                            <button
                                type="button"
                                title="群设置"
                                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                onClick={() =>
                                    ctx.emit("ui:group:manage", {
                                        groupId: groupInfo.id,
                                    })
                                }
                            >
                                <SettingsIcon className="size-4" />
                            </button>
                        ) : null}
                        {searchOpen ? (
                            <div className="flex items-center gap-1 rounded-md bg-muted pl-2">
                                <input
                                    ref={inputRef}
                                    value={query}
                                    placeholder="搜索聊天记录"
                                    className="h-7 w-44 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                                    onChange={(e) => pushQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Escape") {
                                            setSearchOpen(false);
                                            setQuery("");
                                            ctx.emit("ui:chat:search", {
                                                query: "",
                                            });
                                        }
                                    }}
                                />
                                <button
                                    type="button"
                                    title="关闭搜索"
                                    className="rounded p-1 text-muted-foreground hover:text-foreground"
                                    onClick={() => {
                                        setSearchOpen(false);
                                        setQuery("");
                                        ctx.emit("ui:chat:search", {
                                            query: "",
                                        });
                                    }}
                                >
                                    <XIcon className="size-3.5" />
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                title="搜索聊天记录"
                                className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                                onClick={() => {
                                    setSearchOpen(true);
                                    requestAnimationFrame(() =>
                                        inputRef.current?.focus(),
                                    );
                                }}
                            >
                                <SearchIcon className="size-4" />
                            </button>
                        )}
                    </div>
                </div>
            );
        };

        return ui.register("header", Header);
    },
};
