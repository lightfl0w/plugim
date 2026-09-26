import type { Context } from "@plugim/core";
import {
    ClockIcon,
    FileIcon,
    ShieldIcon,
    Trash2Icon,
    UserCheckIcon,
    UsersIcon,
} from "lucide-react";
import {
    useCallback,
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import { formatBytes } from "./ui-shared";
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
    messages: number;
    mediaBytes: number;
    retentionDays: number;
}

interface AdminMessageRow {
    id: string;
    session: string;
    sender: string;
    content: string;
    createdAt: string;
    kind?: string;
    file?: { name: string; size: number } | null;
}

const PAGE = 20;

const sessionLabel = (session: string) =>
    session.startsWith("p2p:")
        ? `私聊 ${session.slice(4).split("|").join(" / ")}`
        : session.startsWith("g:")
          ? `群组 ${session.slice(2, 10)}…`
          : `频道 ${session}`;

const Pager = ({
    offset,
    total,
    page,
    onMove,
}: {
    offset: number;
    total: number;
    page: number;
    onMove: (offset: number) => void;
}) => {
    const last = Math.max(0, Math.ceil(total / page) - 1);
    const current = Math.floor(offset / page);
    if (total <= page) return null;
    return (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <Button
                size="sm"
                variant="outline"
                disabled={current === 0}
                onClick={() => onMove((current - 1) * page)}
            >
                上一页
            </Button>
            <span>
                {current + 1} / {last + 1}
            </span>
            <Button
                size="sm"
                variant="outline"
                disabled={current >= last}
                onClick={() => onMove((current + 1) * page)}
            >
                下一页
            </Button>
        </div>
    );
};

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
        const [tab, setTab] = useState<
            "users" | "groups" | "messages" | "files" | "system"
        >("users");
        const [users, setUsers] = useState<AdminUserRow[]>([]);
        const [groups, setGroups] = useState<AdminGroupRow[]>([]);
        const [stats, setStats] = useState<AdminStats | null>(null);
        const [error, setError] = useState<string | null>(null);
        const [msgKeyword, setMsgKeyword] = useState("");
        const [msgSender, setMsgSender] = useState("");
        const [msgRows, setMsgRows] = useState<AdminMessageRow[]>([]);
        const [msgTotal, setMsgTotal] = useState(0);
        const [msgOffset, setMsgOffset] = useState(0);
        const [fileRows, setFileRows] = useState<AdminMessageRow[]>([]);
        const [fileTotal, setFileTotal] = useState(0);
        const [fileBytes, setFileBytes] = useState(0);
        const [fileOffset, setFileOffset] = useState(0);
        const [retention, setRetention] = useState("");
        const msgFiltersRef = useRef({ keyword: "", sender: "" });

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

        const loadMessages = useCallback((offset: number) => {
            void rpc
                .call("admin.messages", {
                    keyword: msgFiltersRef.current.keyword || undefined,
                    sender: msgFiltersRef.current.sender || undefined,
                    offset,
                    limit: PAGE,
                })
                .then((result) => {
                    const data = result as {
                        rows: AdminMessageRow[];
                        total: number;
                    };
                    setMsgRows(data.rows);
                    setMsgTotal(data.total);
                    setMsgOffset(offset);
                })
                .catch((err) =>
                    setError(String(err instanceof Error ? err.message : err)),
                );
        }, []);

        const loadFiles = useCallback((offset: number) => {
            void rpc
                .call("admin.files", { offset, limit: PAGE })
                .then((result) => {
                    const data = result as {
                        rows: AdminMessageRow[];
                        total: number;
                        totalBytes: number;
                    };
                    setFileRows(data.rows);
                    setFileTotal(data.total);
                    setFileBytes(data.totalBytes);
                    setFileOffset(offset);
                })
                .catch((err) =>
                    setError(String(err instanceof Error ? err.message : err)),
                );
        }, []);

        useEffect(() => {
            if (!allowed) return;
            if (tab === "messages") loadMessages(0);
            if (tab === "files") loadFiles(0);
        }, [tab, allowed, loadMessages, loadFiles]);

        useEffect(() => {
            if (tab === "system" && stats)
                setRetention(String(stats.retentionDays));
        }, [tab, stats]);

        const saveRetention = () => {
            const days = Number(retention);
            void rpc
                .call("admin.retention.set", { days })
                .then(() => refresh())
                .catch((err) =>
                    alert(String(err instanceof Error ? err.message : err)),
                );
        };

        const runCleanup = () => {
            void rpc
                .call("admin.cleanup", {})
                .then((result) => {
                    const { deleted } = result as { deleted: number };
                    alert(`已清理 ${deleted} 条过期消息`);
                    refresh();
                })
                .catch((err) =>
                    alert(String(err instanceof Error ? err.message : err)),
                );
        };

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
            { key: "messages" as const, label: "消息检索" },
            { key: "files" as const, label: "文件管理" },
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
                    {tab === "messages" ? (
                        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                            <form
                                className="flex items-center gap-2"
                                onSubmit={(e) => {
                                    e.preventDefault();
                                    loadMessages(0);
                                }}
                            >
                                <Input
                                    value={msgKeyword}
                                    onChange={(e) => {
                                        setMsgKeyword(e.target.value);
                                        msgFiltersRef.current.keyword =
                                            e.target.value;
                                    }}
                                    placeholder="关键字"
                                    className="h-9 max-w-48"
                                />
                                <Input
                                    value={msgSender}
                                    onChange={(e) => {
                                        setMsgSender(e.target.value);
                                        msgFiltersRef.current.sender =
                                            e.target.value;
                                    }}
                                    placeholder="发送者"
                                    className="h-9 w-28"
                                />
                                <Button
                                    size="sm"
                                    variant="outline"
                                    type="submit"
                                >
                                    查询
                                </Button>
                                <span className="ml-auto text-xs text-muted-foreground">
                                    共 {msgTotal} 条
                                </span>
                            </form>
                            <div className="flex flex-col rounded-xl border border-border bg-card">
                                {msgRows.length === 0 ? (
                                    <p className="py-8 text-center text-xs text-muted-foreground">
                                        没有匹配的消息
                                    </p>
                                ) : null}
                                {msgRows.map((row) => (
                                    <div
                                        key={row.id}
                                        className="flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                                    >
                                        <span className="w-24 shrink-0 text-xs text-muted-foreground">
                                            {row.createdAt
                                                .slice(5, 16)
                                                .replace("T", " ")}
                                        </span>
                                        <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                                            {sessionLabel(row.session)}
                                        </span>
                                        <span className="w-20 shrink-0 truncate font-medium">
                                            {row.sender}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">
                                            {row.kind && row.kind !== "text"
                                                ? `[${row.kind}] ${row.file?.name ?? ""}`
                                                : row.content}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            <Pager
                                offset={msgOffset}
                                total={msgTotal}
                                page={PAGE}
                                onMove={loadMessages}
                            />
                        </div>
                    ) : null}
                    {tab === "files" ? (
                        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
                            <p className="text-xs text-muted-foreground">
                                媒体消息 {fileTotal} 条,占用约{" "}
                                {formatBytes(fileBytes)}
                            </p>
                            <div className="flex flex-col rounded-xl border border-border bg-card">
                                {fileRows.length === 0 ? (
                                    <p className="py-8 text-center text-xs text-muted-foreground">
                                        暂无媒体文件
                                    </p>
                                ) : null}
                                {fileRows.map((row) => (
                                    <div
                                        key={row.id}
                                        className="flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                                    >
                                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate">
                                            {row.file?.name ??
                                                row.content.slice(0, 40)}
                                        </span>
                                        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
                                            {row.file
                                                ? formatBytes(row.file.size)
                                                : "—"}
                                        </span>
                                        <span className="w-16 shrink-0 text-xs text-muted-foreground">
                                            {row.kind}
                                        </span>
                                        <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
                                            {row.sender}
                                        </span>
                                        <span className="w-24 shrink-0 text-xs text-muted-foreground">
                                            {row.createdAt
                                                .slice(5, 16)
                                                .replace("T", " ")}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            <Pager
                                offset={fileOffset}
                                total={fileTotal}
                                page={PAGE}
                                onMove={loadFiles}
                            />
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
                            <div className="grid grid-cols-3 gap-3">
                                <div className="rounded-xl border border-border bg-card p-4 text-center">
                                    <p className="text-2xl font-semibold">
                                        {stats?.messages ?? "—"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        消息总数
                                    </p>
                                </div>
                                <div className="rounded-xl border border-border bg-card p-4 text-center">
                                    <p className="text-2xl font-semibold">
                                        {stats
                                            ? formatBytes(stats.mediaBytes)
                                            : "—"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        媒体占用
                                    </p>
                                </div>
                                <div className="rounded-xl border border-border bg-card p-4 text-center">
                                    <p className="text-2xl font-semibold">
                                        {stats?.retentionDays
                                            ? `${stats.retentionDays} 天`
                                            : "关闭"}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        消息保留期
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
                                <ClockIcon className="size-4 text-muted-foreground" />
                                <p className="flex-1">过期消息自动清理</p>
                                <Input
                                    type="number"
                                    min={0}
                                    max={3650}
                                    value={retention}
                                    onChange={(e) =>
                                        setRetention(e.target.value)
                                    }
                                    className="h-8 w-20"
                                />
                                <span className="text-xs text-muted-foreground">
                                    天,0 为不限制
                                </span>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={saveRetention}
                                >
                                    保存
                                </Button>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={!stats?.retentionDays}
                                    onClick={runCleanup}
                                >
                                    立即清理
                                </Button>
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
