import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import { useEffect, useState } from "react";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { UiService } from "./shell";

export const uiSidebarPlugin: Plugin = {
    name: "ui-sidebar",
    inject: ["ui", "rpc", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");
        const friends = ctx.get<FriendsService>("friends");

        const Sidebar = () => {
            const [list, setList] = useState<FriendListResult | null>(null);
            const [status, setStatus] = useState(rpc.status());

            useEffect(() => rpc.onStatus(setStatus), [rpc]);

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

            return (
                <div className="flex flex-col gap-1 p-3">
                    <p className="px-2 pb-1 text-xs font-semibold text-muted-foreground">
                        会话
                    </p>
                    <button
                        type="button"
                        className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        onClick={() =>
                            ctx.emit("ui:chat:open", {
                                session: "general",
                                title: "综合频道",
                            })
                        }
                    >
                        综合频道
                    </button>
                    <p className="px-2 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
                        好友（{list?.friends.length ?? 0}）
                    </p>
                    {(list?.friends ?? []).map((name) => (
                        <button
                            key={name}
                            type="button"
                            className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                            onClick={() =>
                                ctx.emit("ui:chat:open", {
                                    session: `p2p:${name}`,
                                    title: name,
                                })
                            }
                        >
                            {name}
                        </button>
                    ))}
                    {list?.friends.length === 0 ? (
                        <p className="px-2 text-xs text-muted-foreground">
                            去右上角「好友」添加
                        </p>
                    ) : null}
                </div>
            );
        };

        ui.register("sidebar", Sidebar);
        return undefined;
    },
};
