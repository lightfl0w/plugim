import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import { LogOutIcon, MessagesSquareIcon, UsersIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { UiService } from "./shell";

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
    inject: ["ui", "auth", "rpc", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const rpc = ctx.get<RpcService>("rpc");
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
            const [list, setList] = useState<FriendListResult | null>(null);
            const [status, setStatus] = useState(rpc.status());
            const [active, setActive] = useState("general");
            const navigate = useNavigate();

            useEffect(() => rpc.onStatus(setStatus), [rpc]);

            useEffect(() => {
                const disposeOpen = ctx.on("ui:chat:open", (payload) => {
                    setActive((payload as { session: string }).session);
                });
                return () => {
                    void disposeOpen();
                };
            }, [ctx]);

            useEffect(() => {
                if (status !== "open") return;
                friends
                    .list()
                    .then(setList)
                    .catch(() => undefined);
                return friends.onUpdate(() => {
                    friends
                        .list()
                        .then(setList)
                        .catch(() => undefined);
                });
            }, [friends, status]);

            const roomButton = (
                session: string,
                label: string,
                avatarName?: string,
            ) => (
                <Button
                    key={session}
                    variant="ghost"
                    className={cn(
                        "h-10 w-full justify-start gap-2 rounded-lg",
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
                </Button>
            );

            return (
                <>
                    <div className="flex h-12 min-h-12 items-center px-4">
                        <p className="text-sm font-semibold">会话</p>
                    </div>
                    <div className="flex flex-col gap-1 px-2">
                        {roomButton("general", "综合频道")}
                    </div>
                    <p className="px-4 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
                        好友（{list?.friends.length ?? 0}）
                    </p>
                    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pb-2">
                        {(list?.friends ?? []).map((name) =>
                            roomButton(`p2p:${name}`, name, name),
                        )}
                        {list?.friends.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-muted-foreground">
                                去「好友」页添加
                            </p>
                        ) : null}
                    </div>
                </>
            );
        };

        ui.register("nav", Nav);
        ui.register("sidebar", Sessions);
        return undefined;
    },
};
