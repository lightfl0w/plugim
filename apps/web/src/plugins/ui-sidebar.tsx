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
import type { CacheService } from "./cache";
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
            body: message.content.slice(0, 80),
            tag: message.session,
        });
    } catch {
    }
};

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
    description: "会话与好友侧边栏",
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
            const activeRef = useRef(active);
            const unreadRef = useRef<Record<string, number>>({});
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

            useEffect(() => {
                if (!me) return;
                void cache
                    .getUnread(me)
                    .then((saved) => {
                        if (Object.keys(saved).length === 0) return;
                        applyUnread(saved);
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
                    if (message.sender === auth.user()?.username) return;
                    if (message.session === activeRef.current) return;
                    applyUnread({
                        ...unreadRef.current,
                        [message.session]:
                            (unreadRef.current[message.session] ?? 0) + 1,
                    });
                    notifyInBackground(message);
                });
                return () => {
                    void disposeOpen();
                    void disposeMsg();
                };
            }, [applyUnread]);

            useEffect(() => {
                setList(friends.cached());
                void friends.refresh().catch(() => undefined);
                return friends.onUpdate(() => setList(friends.cached()));
            }, []);

            const roomButton = (
                session: string,
                label: string,
                avatarName?: string,
                count = 0,
            ) => (
                <Button
                    key={session}
                    variant="ghost"
                    className={cn(
                        "h-10 w-full justify-start gap-2 rounded-lg pr-2",
                        active === session
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "text-foreground hover:bg-accent",
                    )}
                    onClick={() => {
                        ctx.emit("ui:chat:open", { session, title: label });
                        navigate("/chat");
                    }}
                >
                    {avatarName ? (
                        <UserAvatar name={avatarName} size="sm" />
                    ) : (
                        <span className="font-semibold">#</span>
                    )}
                    <span className="truncate">{label}</span>
                    {count > 0 ? (
                        <span className="ml-auto flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-xs font-medium text-white">
                            {count > 99 ? "99+" : count}
                        </span>
                    ) : null}
                </Button>
            );

            return (
                <>
                    <div className="flex h-12 min-h-12 items-center px-4">
                        <p className="text-sm font-semibold">会话</p>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
                        {roomButton(
                            "general",
                            "群聊",
                            undefined,
                            unread.general ?? 0,
                        )}
                        {(list?.friends ?? []).map((name) =>
                            roomButton(
                                `p2p:${name}`,
                                name,
                                name,
                                unread[`p2p:${name}`] ?? 0,
                            ),
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
