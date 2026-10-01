import type { Context } from "@plugim/core";
import type { GroupInfo } from "@plugim/protocol";
import {
    ArrowLeftIcon,
    PictureInPicture2Icon,
    SearchIcon,
    SettingsIcon,
    XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { PresenceService } from "./presence";
import {
    displayName,
    isPopupWindow,
    openDetachedChat,
    presenceStatusMeta,
    setShellPane,
    useChatTarget,
    useShellPane,
} from "./ui-shared";
import type { UiService } from "./ui-types";

export const uiHeaderSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");
    const presence = ctx.get<PresenceService>("presence");
    const friends = ctx.get<FriendsService>("friends");

    const Header = () => {
        const [status, setStatus] = useState(rpc.status());
        const { session, title } = useChatTarget();
        const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
        const [searchOpen, setSearchOpen] = useState(false);
        const [query, setQuery] = useState("");
        const pane = useShellPane();
        const inputRef = useRef<HTMLInputElement>(null);
        const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(
            undefined,
        );
        const [, setPresenceTick] = useState(0);
        useEffect(
            () => presence.onChange(() => setPresenceTick((t) => t + 1)),
            [],
        );
        useEffect(
            () => friends.onUpdate(() => setPresenceTick((t) => t + 1)),
            [],
        );

        useEffect(() => rpc.onStatus(setStatus), []);

        useEffect(() => {
            const disposeOpen = ctx.on("ui:chat:open", () => {
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

        const peerName = session.startsWith("p2p:") ? session.slice(4) : null;
        const peerStatus = peerName
            ? (presence.statusOf(peerName) ?? null)
            : null;
        const peerLabel = peerName
            ? presence.isOnline(peerName) && peerStatus
                ? presenceStatusMeta(peerStatus).label
                : "离线"
            : null;
        const popup = isPopupWindow();
        const groupName = session.startsWith("g:")
            ? groupInfo?.name
            : undefined;
        const shownTitle = peerName
            ? displayName(peerName, friends.cached()?.remarks)
            : groupName || title || "选择会话";

        return (
            <div className="flex w-full min-w-0 items-center gap-2">
                {!popup && pane === "chat" ? (
                    <button
                        type="button"
                        title="返回会话列表"
                        className="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
                        onClick={() => setShellPane("list")}
                    >
                        <ArrowLeftIcon className="size-4" />
                    </button>
                ) : null}
                <p className="min-w-0 truncate text-sm font-semibold">
                    {shownTitle}
                </p>
                {groupInfo ? (
                    <span className="shrink-0 text-xs text-muted-foreground">
                        ({groupInfo.memberCount})
                    </span>
                ) : null}
                {peerLabel ? (
                    <span
                        className={
                            presence.isOnline(peerName ?? "")
                                ? "shrink-0 text-xs text-emerald-600"
                                : "shrink-0 text-xs text-muted-foreground"
                        }
                    >
                        {peerLabel}
                    </span>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
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
                    {session && !popup ? (
                        <button
                            type="button"
                            title="独立窗口"
                            className="hidden rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground md:block"
                            onClick={() => openDetachedChat(session)}
                        >
                            <PictureInPicture2Icon className="size-4" />
                        </button>
                    ) : null}
                    {searchOpen ? (
                        <div className="flex items-center gap-1 rounded-md bg-muted pl-2">
                            <input
                                ref={inputRef}
                                value={query}
                                placeholder="搜索聊天记录"
                                className="h-7 w-28 bg-transparent text-xs outline-none placeholder:text-muted-foreground sm:w-44"
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
};
