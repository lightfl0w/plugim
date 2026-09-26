import type { Context } from "@plugim/core";
import { ShieldIcon, Trash2Icon, UserCheckIcon, UsersIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { UiService } from "./ui-types";

export interface AdminService {
    is(): boolean;
    onChange(cb: () => void): () => void;
}

interface AdminUserRow {
    id: string;
    username: string;
    createdAt: string;
    isAdmin: boolean;
    banned: boolean;
    online: boolean;
}

interface AdminGroupRow {
    id: string;
    name: string;
    ownerName: string;
    memberCount: number;
    createdAt: string;
}

interface AdminStats {
    users: number;
    groups: number;
    connections: number;
}

export const uiAdminSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const rpc = ctx.get<RpcService>("rpc");

    let isAdmin = false;
    const adminSubs = new Set<() => void>();
    const setAdmin = (next: boolean) => {
        if (isAdmin === next) return;
        isAdmin = next;
        for (const cb of adminSubs) cb();
    };
    const checkAdmin = () => {
        if (!auth.user()) {
            setAdmin(false);
            return;
        }
        void rpc
            .call("admin.stats", {})
            .then(() => setAdmin(true))
            .catch(() => setAdmin(false));
    };
    ctx.provide<AdminService>("admin", {
        is: () => isAdmin,
        onChange(cb) {
            adminSubs.add(cb);
            return () => {
                adminSubs.delete(cb);
            };
        },
    });
    const offUser = auth.onChange(checkAdmin);
    const offStatus = rpc.onStatus((status) => {
        if (status === "open") checkAdmin();
    });
    checkAdmin();

    const AdminPage = () => {
        const allowed = useSyncExternalStore(
            (cb) => ctx.get<AdminService>("admin").onChange(cb),
            () => ctx.get<AdminService>("admin").is(),
        );
        const [tab, setTab] = useState<"users" | "groups" | "system">("users");
        const [users, setUsers] = useState<AdminUserRow[]>([]);
        const [groups, setGroups] = useState<AdminGroupRow[]>([]);
        const [stats, setStats] = useState<AdminStats | null>(null);
        const [error, setError] = useState<string | null>(null);

        const refresh = useCallback(() => {
            void Promise.all([
                rpc.call("admin.users", {}) as Promise<AdminUserRow[]>,
                rpc.call("admin.groups", {}) as Promise<AdminGroupRow[]>,
                rpc.call("admin.stats", {}) as Promise<AdminStats>,
            ])
                .then(([nextUsers, nextGroups, nextStats]) => {
                    setUsers(nextUsers);
                    setGroups(nextGroups);
                    setStats(nextStats);
                    setError(null);
                })
                .catch((err) =>
                    setError(String(err instanceof Error ? err.message : err)),
                );
        }, []);

        useEffect(() => {
            if (allowed) refresh();
        }, [allowed, refresh]);

        if (!allowed) {
            return (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    需要管理员权限
                </div>
            );
        }

        const act = async (method: string, params: Record<string, unknown>) => {
            try {
                await rpc.call(method, params);
                refresh();
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            }
        };

        const tabs = [
            { key: "users" as const, label: "用户管理" },
            { key: "groups" as const, label: "群组管理" },
            { key: "system" as const, label: "系统设置" },
        ];

        return (
            <div className="flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-2 border-b border-border px-4">
                    <ShieldIcon className="size-4 text-primary" />
                    <p className="text-sm font-semibold">后台管理</p>
                    <div className="ml-4 flex gap-1">
                        {tabs.map((item) => (
                            <button
                                key={item.key}
                                type="button"
                                className={cn(
                                    "rounded-md px-3 py-1 text-xs",
                                    tab === item.key
                                        ? "bg-primary text-primary-foreground"
                                        : "text-muted-foreground hover:bg-accent",
                                )}
                                onClick={() => setTab(item.key)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        title="刷新"
                        className="ml-auto"
                        onClick={refresh}
                    >
                        <UsersIcon />
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {error ? (
                        <p className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                            {error}
                        </p>
                    ) : null}
                    {tab === "users" ? (
                        <div className="flex flex-col gap-1">
                            {users.map((user) => (
                                <div
                                    key={user.id}
                                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/60"
                                >
                                    <UserAvatar
                                        name={user.username}
                                        size="sm"
                                    />
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {user.username}
                                            {user.isAdmin ? (
                                                <span className="ml-1.5 text-xs text-primary">
                                                    管理员
                                                </span>
                                            ) : null}
                                            {user.banned ? (
                                                <span className="ml-1.5 text-xs text-destructive">
                                                    已封禁
                                                </span>
                                            ) : null}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            注册于 {user.createdAt.slice(0, 10)}{" "}
                                            {user.online ? "在线" : "离线"}
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            void act("admin.grant", {
                                                userId: user.id,
                                                on: !user.isAdmin,
                                            })
                                        }
                                    >
                                        {user.isAdmin
                                            ? "取消管理员"
                                            : "设为管理员"}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant={
                                            user.banned
                                                ? "outline"
                                                : "destructive"
                                        }
                                        onClick={() =>
                                            void act("admin.ban", {
                                                userId: user.id,
                                                on: !user.banned,
                                            })
                                        }
                                    >
                                        {user.banned ? "解封" : "封禁"}
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {tab === "groups" ? (
                        <div className="flex flex-col gap-1">
                            {groups.length === 0 ? (
                                <p className="py-8 text-center text-xs text-muted-foreground">
                                    暂无群组
                                </p>
                            ) : null}
                            {groups.map((group) => (
                                <div
                                    key={group.id}
                                    className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/60"
                                >
                                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                                        <UsersIcon className="size-5" />
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium">
                                            {group.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            群主 {group.ownerName}，共{" "}
                                            {group.memberCount} 人
                                        </p>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        onClick={async () => {
                                            if (
                                                !confirm(
                                                    `确定解散群「${group.name}」吗？`,
                                                )
                                            )
                                                return;
                                            await act("admin.group.delete", {
                                                groupId: group.id,
                                            });
                                        }}
                                    >
                                        <Trash2Icon />
                                        解散
                                    </Button>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {tab === "system" ? (
                        <div className="mx-auto flex w-full max-w-md flex-col gap-3 pt-4">
                            <div className="grid grid-cols-3 gap-3">
                                <div className="rounded-xl border border-border bg-card p-4 text-center">
                                    <p className="text-2xl font-semibold">
                                        {stats?.users ?? "—"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        注册用户
                                    </p>
                                </div>
                                <div className="rounded-xl border border-border bg-card p-4 text-center">
                                    <p className="text-2xl font-semibold">
                                        {stats?.groups ?? "—"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        群组总数
                                    </p>
                                </div>
                                <div className="rounded-xl border border-border bg-card p-4 text-center">
                                    <p className="text-2xl font-semibold">
                                        {stats?.connections ?? "—"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        在线连接
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
                                <UserCheckIcon className="size-4 text-muted-foreground" />
                                <p className="flex-1">
                                    首位注册用户自动成为管理员
                                </p>
                            </div>
                            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
                                <ShieldIcon className="size-4 text-muted-foreground" />
                                <p className="flex-1">
                                    管理员可封禁用户、解散任意群组
                                </p>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
        );
    };

    const unregisterRoute = ui.registerRoute("/admin", AdminPage);
    return () => {
        offUser();
        offStatus();
        unregisterRoute();
    };
};
