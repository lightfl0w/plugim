import type { Plugin } from "@plugim/core";
import type { ChatMessage, FriendListResult } from "@plugim/protocol";
import { LogOutIcon, MessagesSquareIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { FriendsService } from "./friends";
import type { UiService } from "./ui";

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
    inject: ["ui", "auth", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const friends = ctx.get<FriendsService>("friends");

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
            const navigate = useNavigate();

            useEffect(() => {
                const disposeOpen = ctx.on("ui:chat:open", (payload) => {
                    const session = (payload as { session: string }).session;
                    activeRef.current = session;
                    setActive(session);
                    setUnread((prev) => {
                        if (!prev[session]) return prev;
                        const { [session]: _drop, ...rest } = prev;
                        return rest;
                    });
                });
                const disposeMsg = ctx.on("server:message:new", (payload) => {
                    const message = (payload as { message: ChatMessage })
                        .message;
                    if (message.sender === auth.user()?.username) return;
                    if (message.session === activeRef.current) return;
                    setUnread((prev) => ({
                        ...prev,
                        [message.session]: (prev[message.session] ?? 0) + 1,
                    }));
                });
                return () => {
                    void disposeOpen();
                    void disposeMsg();
                };
            }, []);

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
