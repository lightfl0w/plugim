import type { Plugin } from "@plugim/core";
import type { ChatMessage, FriendListResult } from "@plugim/protocol";
import { LogOutIcon, MessagesSquareIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { CacheService, SessionPreview } from "./cache";
import type { FriendsService } from "./friends";
import type { UiService } from "./ui";

const BASE_TITLE = "plugim";

const notifyInBackground = (message: ChatMessage) => {
    if (document.visibilityState !== "hidden") return;
    if (
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
    )
        return;
    try {
        new Notification(message.sender, {
            body: previewText(message.content).slice(0, 80),
            tag: message.session,
        });
    } catch {}
};

const previewText = (content: string) =>
    content.startsWith("data:image/") ? "[图片]" : content.replace(/\s+/g, " ");

function previewTime(at: number): string {
    const d = new Date(at);
    const now = new Date();
    const startOf = (x: Date) =>
        new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
    if (diffDays === 0)
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (diffDays === 1) return "昨天";
    if (diffDays < 7) return `星期${"日一二三四五六"[d.getDay()]}`;
    if (d.getFullYear() === now.getFullYear())
        return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function NavIcon({
    to,
    icon,
    label,
}: {
    to: string;
    icon: ReactNode;
    label: string;
}) {
    return (
        <NavLink
            to={to}
            title={label}
            className={({ isActive }) =>
                cn(
                    "flex size-10 items-center justify-center rounded-lg",
                    isActive
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
            }
        >
            {icon}
        </NavLink>
    );
}

export const uiSidebarPlugin: Plugin = {
    name: "ui-sidebar",
    description: "QQ 风格会话列表(预览 / 时间 / 未读)",
    inject: ["ui", "auth", "friends", "cache"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const friends = ctx.get<FriendsService>("friends");
        const cache = ctx.get<CacheService>("cache");

        const Nav = () => {
            const user = auth.user();
            return (
                <>
                    <NavIcon
                        to="/chat"
                        icon={<MessagesSquareIcon className="size-5" />}
                        label="聊天"
                    />
                    <NavIcon
                        to="/friends"
                        icon={<UsersIcon className="size-5" />}
                        label="好友"
                    />
                    <div className="mt-auto flex flex-col items-center gap-1">
                        {user ? (
                            <UserAvatar name={user.username} size="sm" />
                        ) : null}
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            title="退出登录"
                            onClick={() => auth.logout()}
                        >
                            <LogOutIcon />
                        </Button>
                    </div>
                </>
            );
        };

        const Sessions = () => {
            const [list, setList] = useState<FriendListResult | null>(
                friends.cached(),
            );
            const [active, setActive] = useState("general");
            const [unread, setUnread] = useState<Record<string, number>>({});
            const [previews, setPreviews] = useState<
                Record<string, SessionPreview>
            >({});
            const activeRef = useRef(active);
            const unreadRef = useRef<Record<string, number>>({});
            const previewsRef = useRef<Record<string, SessionPreview>>({});
            const navigate = useNavigate();
            const me = auth.user()?.username ?? "";

            const applyUnread = useCallback(
                (next: Record<string, number>) => {
                    unreadRef.current = next;
                    setUnread(next);
                    if (me)
                        void cache.setUnread(me, next).catch(() => undefined);
                    const total = Object.values(next).reduce(
                        (sum, n) => sum + n,
                        0,
                    );
                    document.title =
                        total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
                },
                [me],
            );

            const applyPreview = useCallback((message: ChatMessage) => {
                const at = Date.parse(message.createdAt);
                const current = previewsRef.current[message.session];
                if (current && current.at > at) return;
                const next = {
                    ...previewsRef.current,
                    [message.session]: {
                        id: message.id,
                        sender: message.sender,
                        content: message.recalledAt
                            ? "[消息已撤回]"
                            : message.content,
                        at,
                    },
                };
                previewsRef.current = next;
                setPreviews(next);
            }, []);

            useEffect(() => {
                if (!me) return;
                void cache
                    .getUnread(me)
                    .then((saved) => {
                        if (Object.keys(saved).length === 0) return;
                        applyUnread(saved);
                    })
                    .catch(() => undefined);
                void cache
                    .getPreviews(me)
                    .then((saved) => {
                        previewsRef.current = saved;
                        setPreviews(saved);
                    })
                    .catch(() => undefined);
            }, [me, applyUnread]);

            useEffect(() => {
                const disposeOpen = ctx.on("ui:chat:open", (payload) => {
                    const session = (payload as { session: string }).session;
                    activeRef.current = session;
                    setActive(session);
                    const current = unreadRef.current;
                    if (current[session]) {
                        const { [session]: _drop, ...rest } = current;
                        applyUnread(rest);
                    }
                });
                const disposeMsg = ctx.on("server:message:new", (payload) => {
                    const message = (payload as { message: ChatMessage })
                        .message;
                    applyPreview(message);
                    if (message.sender === auth.user()?.username) return;
                    if (message.session === activeRef.current) return;
                    applyUnread({
                        ...unreadRef.current,
                        [message.session]:
                            (unreadRef.current[message.session] ?? 0) + 1,
                    });
                    notifyInBackground(message);
                });
                const disposeRecall = ctx.on(
                    "server:message:recalled",
                    (payload) => {
                        const { id, session } = payload as {
                            id: string;
                            session: string;
                        };
                        const current = previewsRef.current[session];
                        if (!current || current.id !== id) return;
                        const next = {
                            ...previewsRef.current,
                            [session]: { ...current, content: "[消息已撤回]" },
                        };
                        previewsRef.current = next;
                        setPreviews(next);
                    },
                );
                return () => {
                    void disposeOpen();
                    void disposeMsg();
                    void disposeRecall();
                };
            }, [applyUnread, applyPreview]);

            useEffect(() => {
                setList(friends.cached());
                void friends.refresh().catch(() => undefined);
                return friends.onUpdate(() => setList(friends.cached()));
            }, []);

            const sessionItem = (
                session: string,
                label: string,
                avatar?: ReactNode,
            ) => {
                const preview = previews[session];
                const count = unread[session] ?? 0;
                return (
                    <button
                        key={session}
                        type="button"
                        onClick={() => {
                            ctx.emit("ui:chat:open", { session, title: label });
                            navigate("/chat");
                        }}
                        className={cn(
                            "flex w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                            active === session
                                ? "bg-chat-item-active"
                                : "hover:bg-muted/70",
                        )}
                    >
                        {avatar ?? (
                            <UserAvatar name={label} className="size-10" />
                        )}
                        <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-2">
                                <span className="min-w-0 truncate text-sm font-medium">
                                    {label}
                                </span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                    {preview ? previewTime(preview.at) : ""}
                                </span>
                            </span>
                            <span className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-xs text-muted-foreground">
                                    {preview
                                        ? previewText(preview.content)
                                        : "暂无消息"}
                                </span>
                                {count > 0 ? (
                                    <span className="flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] leading-none font-medium text-white">
                                        {count > 99 ? "99+" : count}
                                    </span>
                                ) : null}
                            </span>
                        </span>
                    </button>
                );
            };

            return (
                <>
                    <div className="flex h-12 min-h-12 items-center gap-2 px-3">
                        <input
                            readOnly
                            placeholder="搜索"
                            className="h-7 w-full rounded-md bg-muted px-2.5 text-xs outline-none placeholder:text-muted-foreground"
                        />
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2">
                        {sessionItem(
                            "general",
                            "群聊",
                            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-sky-400 text-white">
                                <MessagesSquareIcon className="size-5" />
                            </span>,
                        )}
                        {(list?.friends ?? []).map((name) =>
                            sessionItem(`p2p:${name}`, name),
                        )}
                    </div>
                </>
            );
        };

        const unregisterNav = ui.register("nav", Nav);
        const unregisterSidebar = ui.register("sidebar", Sessions);
        return () => {
            unregisterNav();
            unregisterSidebar();
        };
    },
};
