import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import { UserAvatar } from "../components/ui/user-avatar";
import type { FriendsService } from "./friends";
import type { UiService } from "./ui";

type DetailView =
    | { type: "friend"; name: string }
    | { type: "outgoing" }
    | null;

export const uiFriendsPanelPlugin: Plugin = {
    name: "ui-friends-panel",
    description: "好友管理页面",
    inject: ["ui", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const friends = ctx.get<FriendsService>("friends");

        const useFriendList = () => {
            const [list, setList] = useState<FriendListResult | null>(
                friends.cached(),
            );
            useEffect(() => {
                setList(friends.cached());
                void friends.refresh().catch(() => undefined);
                return friends.onUpdate(() => setList(friends.cached()));
            }, []);
            return list;
        };

        const FriendsList = () => {
            const list = useFriendList();
            const [addName, setAddName] = useState("");
            const [error, setError] = useState("");

            const run = async (fn: () => Promise<void>) => {
                setError("");
                try {
                    await fn();
                    setAddName("");
                } catch (err) {
                    setError(err instanceof Error ? err.message : "failed");
                }
            };

            const section = (
                title: string,
                items: ReactNode,
                count: number,
            ) => {
                if (count === 0) return null;
                return (
                    <div className="flex flex-col gap-1">
                        <p className="px-2 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
                            {title}（{count}）
                        </p>
                        {items}
                    </div>
                );
            };

            return (
                <>
                    <div className="flex h-12 min-h-12 items-center px-4">
                        <p className="text-sm font-semibold">好友</p>
                    </div>
                    <div className="flex gap-1 px-2 pb-1">
                        <Input
                            placeholder="输入用户名"
                            value={addName}
                            className="h-9"
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && addName.trim())
                                    void run(() =>
                                        friends.request(addName.trim()),
                                    );
                            }}
                        />
                        <Button
                            size="sm"
                            className="h-9 shrink-0"
                            disabled={!addName.trim()}
                            onClick={() =>
                                void run(() => friends.request(addName.trim()))
                            }
                        >
                            添加
                        </Button>
                    </div>
                    {error ? (
                        <p className="px-4 text-xs text-red-500">{error}</p>
                    ) : null}
                    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
                        {section(
                            "我的好友",
                            <>
                                {(list?.friends ?? []).map((name) => (
                                    <Button
                                        key={name}
                                        variant="ghost"
                                        className="h-10 w-full justify-start gap-2 rounded-lg px-2 text-foreground hover:bg-accent/60"
                                        onClick={() =>
                                            ctx.emit("ui:friend:select", {
                                                name,
                                            })
                                        }
                                    >
                                        <UserAvatar name={name} size="sm" />
                                        <span className="truncate">{name}</span>
                                    </Button>
                                ))}
                                {list?.friends.length === 0 ? (
                                    <p className="px-2 py-1 text-xs text-muted-foreground">
                                        上方输入用户名添加好友
                                    </p>
                                ) : null}
                            </>,
                            list?.friends.length ?? 0,
                        )}
                        {section(
                            "收到的申请",
                            (list?.incoming ?? []).map((name) => (
                                <div
                                    key={name}
                                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-accent/60"
                                >
                                    <span className="flex min-w-0 items-center gap-2">
                                        <UserAvatar name={name} size="sm" />
                                        <span className="truncate text-sm">
                                            {name}
                                        </span>
                                    </span>
                                    <div className="flex shrink-0 gap-1">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 px-2 text-xs"
                                            onClick={() =>
                                                void friends
                                                    .accept(name)
                                                    .catch(() => undefined)
                                            }
                                        >
                                            同意
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="h-7 px-2 text-xs"
                                            onClick={() =>
                                                void friends
                                                    .reject(name)
                                                    .catch(() => undefined)
                                            }
                                        >
                                            拒绝
                                        </Button>
                                    </div>
                                </div>
                            )),
                            list?.incoming.length ?? 0,
                        )}
                        {section(
                            "已屏蔽",
                            (list?.blocked ?? []).map((name) => (
                                <div
                                    key={name}
                                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-accent/60"
                                >
                                    <span className="flex min-w-0 items-center gap-2">
                                        <UserAvatar name={name} size="sm" />
                                        <span className="truncate text-sm">
                                            {name}
                                        </span>
                                    </span>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() =>
                                            void friends
                                                .unblock(name)
                                                .catch(() => undefined)
                                        }
                                    >
                                        取消屏蔽
                                    </Button>
                                </div>
                            )),
                            list?.blocked.length ?? 0,
                        )}
                        <button
                            type="button"
                            className="mt-auto flex h-10 shrink-0 items-center justify-between rounded-lg px-3 text-sm text-muted-foreground hover:bg-accent/60"
                            onClick={() => ctx.emit("ui:friends:view", {})}
                        >
                            <span>已发出的申请</span>
                            <span>{list?.outgoing.length ?? 0}</span>
                        </button>
                    </div>
                </>
            );
        };

        const OutgoingView = () => {
            const list = useFriendList();
            return (
                <div className="flex h-full flex-col">
                    <div className="flex h-12 min-h-12 shrink-0 items-center border-b border-border px-4">
                        <p className="text-sm font-semibold">
                            已发出的申请（{list?.outgoing.length ?? 0}）
                        </p>
                    </div>
                    <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
                        {(list?.outgoing ?? []).map((name) => (
                            <div
                                key={name}
                                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-accent/60"
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <UserAvatar name={name} size="sm" />
                                    <span className="truncate text-sm">
                                        {name}
                                    </span>
                                </span>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        void friends
                                            .reject(name)
                                            .catch(() => undefined)
                                    }
                                >
                                    撤销
                                </Button>
                            </div>
                        ))}
                        {list?.outgoing.length === 0 ? (
                            <p className="p-4 text-sm text-muted-foreground">
                                暂无已发出的好友申请
                            </p>
                        ) : null}
                    </div>
                </div>
            );
        };

        const FriendDetail = ({ name }: { name: string }) => {
            const navigate = useNavigate();
            return (
                <div className="flex h-full flex-col overflow-y-auto">
                    <div className="h-28 shrink-0 bg-muted" />
                    <div className="-mt-10 flex items-end gap-4 px-6 pb-4">
                        <UserAvatar
                            name={name}
                            size="lg"
                            className="ring-4 ring-background"
                        />
                        <div className="flex-1 pb-1">
                            <p className="text-xl font-semibold">{name}</p>
                            <p className="text-xs text-muted-foreground">
                                好友
                            </p>
                        </div>
                        <div className="flex gap-2 pb-1">
                            <Button
                                onClick={() => {
                                    ctx.emit("ui:chat:open", {
                                        session: `p2p:${name}`,
                                        title: name,
                                    });
                                    navigate("/chat");
                                }}
                            >
                                发消息
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() =>
                                    void friends
                                        .block(name)
                                        .catch(() => undefined)
                                }
                            >
                                屏蔽
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() =>
                                    void friends
                                        .remove(name)
                                        .catch(() => undefined)
                                }
                            >
                                删除
                            </Button>
                        </div>
                    </div>
                    <Separator />
                    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                        暂无更多资料
                    </div>
                </div>
            );
        };

        const FriendsDetail = () => {
            const [view, setView] = useState<DetailView>(null);
            useEffect(() => {
                const disposeSelect = ctx.on("ui:friend:select", (payload) => {
                    setView({
                        type: "friend",
                        name: (payload as { name: string }).name,
                    });
                });
                const disposeView = ctx.on("ui:friends:view", () => {
                    setView({ type: "outgoing" });
                });
                return () => {
                    void disposeSelect();
                    void disposeView();
                };
            }, []);

            if (!view) {
                return (
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                        从左侧选择一个好友查看详情
                    </div>
                );
            }
            if (view.type === "outgoing") return <OutgoingView />;
            return <FriendDetail name={view.name} />;
        };

        const unregisterList = ui.register("friends-list", FriendsList);
        const unregisterDetail = ui.register("friends-detail", FriendsDetail);
        return () => {
            unregisterList();
            unregisterDetail();
        };
    },
};
