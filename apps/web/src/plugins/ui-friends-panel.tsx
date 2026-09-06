import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import type { FriendsService } from "./friends";
import type { UiService } from "./shell";

function FriendRow({
    name,
    actions,
}: {
    name: string;
    actions: { label: string; run: () => void }[];
}) {
    return (
        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
            <span className="truncate text-sm">{name}</span>
            <div className="flex shrink-0 gap-1">
                {actions.map((action) => (
                    <Button
                        key={action.label}
                        variant="outline"
                        size="sm"
                        onClick={action.run}
                    >
                        {action.label}
                    </Button>
                ))}
            </div>
        </div>
    );
}

export const uiFriendsPanelPlugin: Plugin = {
    name: "ui-friends-panel",
    inject: ["ui", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const friends = ctx.get<FriendsService>("friends");

        const FriendsPage = () => {
            const [list, setList] = useState<FriendListResult | null>(null);
            const [addName, setAddName] = useState("");
            const [error, setError] = useState("");

            useEffect(() => {
                const refresh = () => {
                    friends
                        .list()
                        .then(setList)
                        .catch(() => undefined);
                };
                refresh();
                return friends.onUpdate(refresh);
            }, [friends]);

            const run = async (fn: () => Promise<FriendListResult>) => {
                setError("");
                try {
                    setList(await fn());
                    setAddName("");
                } catch (err) {
                    setError(err instanceof Error ? err.message : "failed");
                }
            };

            return (
                <div className="mx-auto flex w-full max-w-md flex-col gap-4">
                    <h2 className="text-lg font-semibold">好友</h2>
                    <div className="flex gap-2">
                        <Input
                            placeholder="输入用户名添加好友"
                            value={addName}
                            onChange={(e) => setAddName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && addName.trim())
                                    void run(() =>
                                        friends.request(addName.trim()),
                                    );
                            }}
                        />
                        <Button
                            disabled={!addName.trim()}
                            onClick={() =>
                                void run(() => friends.request(addName.trim()))
                            }
                            className="shrink-0"
                        >
                            添加
                        </Button>
                    </div>
                    {error ? (
                        <p className="text-xs text-red-500">{error}</p>
                    ) : null}
                    {list ? (
                        <div className="flex flex-col gap-4">
                            {list.incoming.length > 0 ? (
                                <div>
                                    <p className="mb-1 text-xs text-muted-foreground">
                                        收到的申请
                                    </p>
                                    {list.incoming.map((name) => (
                                        <FriendRow
                                            key={name}
                                            name={name}
                                            actions={[
                                                {
                                                    label: "同意",
                                                    run: () =>
                                                        void run(() =>
                                                            friends.accept(
                                                                name,
                                                            ),
                                                        ),
                                                },
                                                {
                                                    label: "拒绝",
                                                    run: () =>
                                                        void run(() =>
                                                            friends.reject(
                                                                name,
                                                            ),
                                                        ),
                                                },
                                            ]}
                                        />
                                    ))}
                                </div>
                            ) : null}
                            <div>
                                <p className="mb-1 text-xs text-muted-foreground">
                                    我的好友（{list.friends.length}）
                                </p>
                                {list.friends.length === 0 ? (
                                    <p className="px-2 text-xs text-muted-foreground">
                                        还没有好友
                                    </p>
                                ) : (
                                    list.friends.map((name) => (
                                        <FriendRow
                                            key={name}
                                            name={name}
                                            actions={[
                                                {
                                                    label: "删除",
                                                    run: () =>
                                                        void run(() =>
                                                            friends.remove(
                                                                name,
                                                            ),
                                                        ),
                                                },
                                                {
                                                    label: "屏蔽",
                                                    run: () =>
                                                        void run(() =>
                                                            friends.block(name),
                                                        ),
                                                },
                                            ]}
                                        />
                                    ))
                                )}
                            </div>
                            {list.outgoing.length > 0 ? (
                                <div>
                                    <p className="mb-1 text-xs text-muted-foreground">
                                        已发出的申请
                                    </p>
                                    {list.outgoing.map((name) => (
                                        <FriendRow
                                            key={name}
                                            name={name}
                                            actions={[
                                                {
                                                    label: "撤销",
                                                    run: () =>
                                                        void run(() =>
                                                            friends.reject(
                                                                name,
                                                            ),
                                                        ),
                                                },
                                            ]}
                                        />
                                    ))}
                                </div>
                            ) : null}
                            {list.blocked.length > 0 ? (
                                <div>
                                    <p className="mb-1 text-xs text-muted-foreground">
                                        已屏蔽
                                    </p>
                                    {list.blocked.map((name) => (
                                        <FriendRow
                                            key={name}
                                            name={name}
                                            actions={[
                                                {
                                                    label: "取消屏蔽",
                                                    run: () =>
                                                        void run(() =>
                                                            friends.unblock(
                                                                name,
                                                            ),
                                                        ),
                                                },
                                            ]}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            );
        };

        ui.register("friends-page", FriendsPage);
        return undefined;
    },
};
