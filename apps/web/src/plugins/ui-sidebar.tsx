import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import { LogOutIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import { UserAvatar } from "../components/ui/user-avatar";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { UiService } from "./shell";

export const uiSidebarPlugin: Plugin = {
    name: "ui-sidebar",
    inject: ["ui", "auth", "rpc", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const rpc = ctx.get<RpcService>("rpc");
        const friends = ctx.get<FriendsService>("friends");

        const Sidebar = () => {
            const [list, setList] = useState<FriendListResult | null>(null);
            const [status, setStatus] = useState(rpc.status());
            const [active, setActive] = useState("general");
            const user = auth.user();

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
                    variant={active === session ? "default" : "ghost"}
                    className="w-full justify-start gap-2"
                    onClick={() =>
                        ctx.emit("ui:chat:open", { session, title: label })
                    }
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
                    <div className="p-3">
                        <h3 className="text-lg font-semibold">会话</h3>
                    </div>
                    <Separator />
                    <div className="flex flex-col gap-1 overflow-y-auto p-2">
                        {roomButton("general", "综合频道")}
                        <p className="px-2 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
                            好友（{list?.friends.length ?? 0}）
                        </p>
                        {(list?.friends ?? []).map((name) =>
                            roomButton(`p2p:${name}`, name, name),
                        )}
                        {list?.friends.length === 0 ? (
                            <p className="px-2 py-1 text-xs text-muted-foreground">
                                点右上角「好友」添加
                            </p>
                        ) : null}
                    </div>
                    <div className="mt-auto">
                        <Separator />
                        <div className="flex items-center justify-between gap-2 p-3">
                            <span className="flex min-w-0 items-center gap-2">
                                {user ? (
                                    <UserAvatar
                                        name={user.username}
                                        size="sm"
                                    />
                                ) : null}
                                <span className="truncate text-sm font-medium">
                                    {user?.username ?? "未登录"}
                                </span>
                            </span>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => auth.logout()}
                            >
                                <LogOutIcon />
                            </Button>
                        </div>
                    </div>
                </>
            );
        };

        ui.register("sidebar", Sidebar);
        return undefined;
    },
};
