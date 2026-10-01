import type { Context } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import {
    ArrowLeftIcon,
    ChevronRightIcon,
    PlusIcon,
    StarIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { FriendsService } from "./friends";
import {
    displayName,
    openChat,
    setShellPane,
    showConfirm,
    usePopupClose,
} from "./ui-shared";
import type { UiService } from "./ui-types";

type DetailView =
    | { type: "friend"; name: string }
    | { type: "outgoing" }
    | null;

const DEFAULT_GROUP = "__default__";

type FriendMenu =
    | { kind: "friend"; x: number; y: number; name: string }
    | { kind: "group"; x: number; y: number; id: string }
    | null;

export const uiFriendsPanelSetup = async (ctx: Context) => {
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
        const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
        const [creating, setCreating] = useState(false);
        const [newName, setNewName] = useState("");
        const [rename, setRename] = useState<{
            id: string;
            text: string;
        } | null>(null);
        const [menu, setMenu] = useState<FriendMenu>(null);
        const menuRef = useRef<HTMLDivElement>(null);

        usePopupClose(menuRef, !!menu, () => setMenu(null));

        const groups = list?.groups ?? [];
        const groupOf = (name: string) => list?.friendGroups?.[name] ?? null;
        const membersIn = (groupId: string | null) =>
            (list?.friends ?? []).filter((name) => groupOf(name) === groupId);

        const run = async (fn: () => Promise<unknown>) => {
            setError("");
            try {
                await fn();
                setAddName("");
            } catch (err) {
                setError(err instanceof Error ? err.message : "failed");
            }
        };

        const toggle = (key: string) =>
            setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
            });

        const moveFriend = (name: string, groupId: string | null) => {
            setMenu(null);
            void run(() => friends.groupMove(name, groupId));
        };

        const groupAction = (action: "rename" | "remove") => {
            if (menu?.kind !== "group") return;
            const group = groups.find((g) => g.id === menu.id);
            setMenu(null);
            if (!group) return;
            if (action === "rename") {
                setRename({ id: group.id, text: group.name });
                return;
            }
            showConfirm(
                `删除分组「${group.name}」？成员将移回我的好友`,
                () => {
                    void run(() => friends.groupRemove(group.id));
                },
                "删除分组",
            );
        };

        const createGroup = () =>
            run(async () => {
                await friends.groupCreate(newName.trim());
                setCreating(false);
                setNewName("");
            });

        const submitRename = () => {
            if (!rename?.text.trim()) return;
            const target = rename;
            void run(async () => {
                await friends.groupRename(target.id, target.text.trim());
                setRename(null);
            });
        };

        const friendRow = (name: string) => (
            <button
                key={name}
                type="button"
                className="flex h-10 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-accent/60"
                onClick={() => {
                    ctx.emit("ui:friend:select", { name });
                    setShellPane("chat");
                }}
                onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({
                        kind: "friend",
                        x: e.clientX,
                        y: e.clientY,
                        name,
                    });
                }}
            >
                <UserAvatar name={name} size="sm" />
                <span className="flex min-w-0 flex-col">
                    <span className="truncate text-sm">
                        {displayName(name, list?.remarks)}
                    </span>
                    {list?.remarks?.[name] ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                            {name}
                        </span>
                    ) : null}
                </span>
                {list?.starred?.includes(name) ? (
                    <StarIcon className="ml-auto size-3.5 shrink-0 fill-amber-400 text-amber-400" />
                ) : null}
            </button>
        );

        const groupNode = (
            key: string,
            label: string,
            names: string[],
            onContext: ((e: ReactMouseEvent) => void) | null,
        ): ReactNode => {
            const isCollapsed = collapsed.has(key);
            return (
                <div key={key} className="flex flex-col">
                    <div className="flex h-9 items-center gap-1 rounded-lg px-1 hover:bg-accent/60">
                        <button
                            type="button"
                            title={isCollapsed ? "展开" : "收起"}
                            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                            onClick={() => toggle(key)}
                        >
                            <ChevronRightIcon
                                className={cn(
                                    "size-4 transition-transform",
                                    !isCollapsed && "rotate-90",
                                )}
                            />
                        </button>
                        {rename?.id === key ? (
                            <Input
                                autoFocus
                                value={rename.text}
                                className="h-7 flex-1"
                                onChange={(e) =>
                                    setRename({
                                        id: key,
                                        text: e.target.value,
                                    })
                                }
                                onKeyDown={(e) => {
                                    if (e.key === "Enter") submitRename();
                                    if (e.key === "Escape") setRename(null);
                                }}
                            />
                        ) : (
                            <button
                                type="button"
                                className="min-w-0 flex-1 truncate rounded px-1 text-left text-xs font-semibold text-muted-foreground"
                                onClick={() => toggle(key)}
                                onContextMenu={(e) => {
                                    if (!onContext) return;
                                    e.preventDefault();
                                    onContext(e);
                                }}
                            >
                                {label}（{names.length}）
                            </button>
                        )}
                    </div>
                    {!isCollapsed ? names.map(friendRow) : null}
                </div>
            );
        };

        const section = (title: string, items: ReactNode, count: number) => {
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
                    <p className="flex-1 text-sm font-semibold">好友</p>
                    <button
                        type="button"
                        title="新建分组"
                        className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        onClick={() => {
                            setCreating((v) => !v);
                            setNewName("");
                        }}
                    >
                        <PlusIcon className="size-4" />
                    </button>
                </div>
                <div className="flex gap-1 px-2 pb-1">
                    <Input
                        placeholder="输入用户名"
                        value={addName}
                        className="h-9"
                        onChange={(e) => setAddName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && addName.trim())
                                void run(() => friends.request(addName.trim()));
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
                {creating ? (
                    <div className="flex gap-1 px-2 pb-1">
                        <Input
                            autoFocus
                            placeholder="分组名称"
                            value={newName}
                            className="h-9"
                            onChange={(e) => setNewName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && newName.trim())
                                    void createGroup();
                                if (e.key === "Escape") {
                                    setCreating(false);
                                    setNewName("");
                                }
                            }}
                        />
                        <Button
                            size="sm"
                            className="h-9 shrink-0"
                            disabled={!newName.trim()}
                            onClick={() => void createGroup()}
                        >
                            创建
                        </Button>
                    </div>
                ) : null}
                {error ? (
                    <p className="px-4 text-xs text-red-500">{error}</p>
                ) : null}
                <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
                    {groupNode(
                        DEFAULT_GROUP,
                        "我的好友",
                        membersIn(null),
                        null,
                    )}
                    {groups.map((group) =>
                        groupNode(
                            group.id,
                            group.name,
                            membersIn(group.id),
                            (e) =>
                                setMenu({
                                    kind: "group",
                                    x: e.clientX,
                                    y: e.clientY,
                                    id: group.id,
                                }),
                        ),
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
                        onClick={() => {
                            ctx.emit("ui:friends:view", {});
                            setShellPane("chat");
                        }}
                    >
                        <span>已发出的申请</span>
                        <span>{list?.outgoing.length ?? 0}</span>
                    </button>
                </div>
                {menu ? (
                    <div
                        ref={menuRef}
                        role="menu"
                        className="fixed z-50 w-44 rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
                        style={{
                            left: Math.min(menu.x, window.innerWidth - 190),
                            top: Math.min(menu.y, window.innerHeight - 250),
                        }}
                    >
                        {menu.kind === "friend" ? (
                            <>
                                <p className="px-3 py-1 text-xs text-muted-foreground">
                                    移动到分组
                                </p>
                                <button
                                    type="button"
                                    className="flex w-full items-center px-3 py-1.5 text-left hover:bg-accent"
                                    onClick={() => moveFriend(menu.name, null)}
                                >
                                    我的好友
                                    {groupOf(menu.name) === null ? (
                                        <span className="ml-auto text-xs text-primary">
                                            当前
                                        </span>
                                    ) : null}
                                </button>
                                {groups.map((group) => (
                                    <button
                                        key={group.id}
                                        type="button"
                                        className="flex w-full items-center px-3 py-1.5 text-left hover:bg-accent"
                                        onClick={() =>
                                            moveFriend(menu.name, group.id)
                                        }
                                    >
                                        <span className="truncate">
                                            {group.name}
                                        </span>
                                        {groupOf(menu.name) === group.id ? (
                                            <span className="ml-auto shrink-0 text-xs text-primary">
                                                当前
                                            </span>
                                        ) : null}
                                    </button>
                                ))}
                            </>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className="w-full px-3 py-1.5 text-left hover:bg-accent"
                                    onClick={() => groupAction("rename")}
                                >
                                    重命名
                                </button>
                                <button
                                    type="button"
                                    className="w-full px-3 py-1.5 text-left hover:bg-accent"
                                    onClick={() => groupAction("remove")}
                                >
                                    删除分组
                                </button>
                            </>
                        )}
                    </div>
                ) : null}
            </>
        );
    };

    const BackBar = () => (
        <div className="flex h-11 min-h-11 shrink-0 items-center px-2 md:hidden">
            <button
                type="button"
                title="返回"
                className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setShellPane("list")}
            >
                <ArrowLeftIcon className="size-4" />
            </button>
        </div>
    );

    const OutgoingView = () => {
        const list = useFriendList();
        return (
            <div className="flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-2 md:px-4">
                    <button
                        type="button"
                        title="返回"
                        className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
                        onClick={() => setShellPane("list")}
                    >
                        <ArrowLeftIcon className="size-4" />
                    </button>
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
                                <span className="truncate text-sm">{name}</span>
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
        const list = useFriendList();
        const remark = list?.remarks?.[name] ?? "";
        return (
            <div className="flex h-full flex-col overflow-y-auto">
                <BackBar />
                <div className="h-28 shrink-0 bg-muted" />
                <div className="-mt-10 flex items-end gap-4 px-4 pb-4 md:px-6">
                    <UserAvatar
                        name={name}
                        size="lg"
                        className="ring-4 ring-background"
                    />
                    <div className="flex-1 pb-1">
                        <p className="text-xl font-semibold">
                            {displayName(name, list?.remarks)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {remark ? `${name} 的好友` : "好友"}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 pb-1">
                        <Button
                            onClick={() => {
                                openChat(ctx, {
                                    session: `p2p:${name}`,
                                    title: displayName(name, list?.remarks),
                                });
                                setShellPane("chat");
                                navigate("/chat");
                            }}
                        >
                            发消息
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() =>
                                void friends.block(name).catch(() => undefined)
                            }
                        >
                            屏蔽
                        </Button>
                        <Button
                            variant="outline"
                            onClick={() =>
                                void friends.remove(name).catch(() => undefined)
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
};
