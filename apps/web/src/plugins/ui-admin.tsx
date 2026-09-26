import type { Context } from "@plugim/core";
import {
    ClockIcon,
    DownloadIcon,
    FileIcon,
    HardDriveIcon,
    PlayIcon,
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
    files: number;
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

interface AdminFileRow {
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderName: string;
    createdAt: string;
}

interface AdminStorageConfig {
    driver: "local" | "s3";
    dir: string;
    uploadLimitMb: number;
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKeySet: boolean;
    pathStyle: boolean;
    publicBase: string;
}

interface StorageDraft {
    driver: "local" | "s3";
    dir: string;
    uploadLimitMb: string;
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    pathStyle: boolean;
    publicBase: string;
}

interface AdminTaskRow {
    name: string;
    title: string;
    description: string;
    enabled: boolean;
    intervalMinutes: number;
    lastRun: string | null;
    lastStatus: "ok" | "error" | null;
    lastMessage: string;
    runs: number;
}

interface TrendPoint {
    date: string;
    messages: number;
    senders: number;
}

const PAGE = 20;
const TREND_DAYS = [7, 14, 30];

const sessionLabel = (session: string) =>
    session.startsWith("p2p:")
        ? `私聊 ${session.slice(4).split("|").join(" / ")}`
        : session.startsWith("g:")
          ? `群组 ${session.slice(2, 10)}…`
          : `频道 ${session}`;

const formatStamp = (iso: string | null) =>
    iso ? iso.slice(5, 16).replace("T", " ") : "未执行";

const storageDraftOf = (cfg: AdminStorageConfig): StorageDraft => ({
    driver: cfg.driver,
    dir: cfg.dir,
    uploadLimitMb: String(cfg.uploadLimitMb),
    endpoint: cfg.endpoint,
    region: cfg.region,
    bucket: cfg.bucket,
    accessKey: cfg.accessKey,
    secretKey: "",
    pathStyle: cfg.pathStyle,
    publicBase: cfg.publicBase,
});

const StorageField = ({
    label,
    value,
    placeholder,
    type,
    onChange,
}: {
    label: string;
    value: string;
    placeholder?: string;
    type?: string;
    onChange: (value: string) => void;
}) => (
    <div className="flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Input
            value={value}
            type={type}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            className="h-8"
        />
    </div>
);

const TrendChart = ({ points }: { points: TrendPoint[] }) => {
    const width = 640;
    const height = 170;
    const pad = 26;
    if (points.length === 0)
        return (
            <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card text-xs text-muted-foreground">
                暂无统计数据
            </div>
        );
    const max = Math.max(1, ...points.map((point) => point.messages));
    const maxSenders = Math.max(1, ...points.map((point) => point.senders));
    const step = (width - pad * 2) / Math.max(1, points.length - 1);
    const x = (index: number) => pad + index * step;
    const y = (value: number, scale = max) =>
        height - pad - (value / scale) * (height - pad * 2);
    const bar = Math.max(3, step * 0.5);
    return (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between text-xs">
                <p className="font-medium">近 {points.length} 天消息量</p>
                <span className="flex items-center gap-3 text-muted-foreground">
                    <span className="flex items-center gap-1">
                        <span className="size-2 rounded-sm bg-primary" />
                        消息
                    </span>
                    <span className="flex items-center gap-1">
                        <span className="size-2 rounded-sm bg-amber-500" />
                        活跃用户
                    </span>
                </span>
            </div>
            <svg
                viewBox={`0 0 ${width} ${height}`}
                className="h-40 w-full"
                role="img"
                aria-label="按天消息量与活跃用户趋势"
            >
                <title>按天消息量与活跃用户趋势</title>
                <line
                    x1={pad}
                    y1={y(0)}
                    x2={width - pad}
                    y2={y(0)}
                    className="stroke-border"
                    strokeWidth={1}
                />
                {points.map((point, index) => (
                    <rect
                        key={point.date}
                        x={x(index) - bar / 2}
                        y={y(point.messages)}
                        width={bar}
                        height={Math.max(0, y(0) - y(point.messages))}
                        rx={2}
                        className="fill-primary/70"
                    >
                        <title>
                            {`${point.date} 消息 ${point.messages} 条 / 活跃 ${point.senders} 人`}
                        </title>
                    </rect>
                ))}
                <polyline
                    points={points
                        .map(
                            (point, index) =>
                                `${x(index)},${y(point.senders, maxSenders)}`,
                        )
                        .join(" ")}
                    fill="none"
                    className="stroke-amber-500"
                    strokeWidth={2}
                />
                {points.map((point, index) => (
                    <circle
                        key={point.date}
                        cx={x(index)}
                        cy={y(point.senders, maxSenders)}
                        r={2.5}
                        className="fill-amber-500"
                    />
                ))}
                <text
                    x={pad}
                    y={height - 6}
                    className="fill-muted-foreground text-[10px]"
                >
                    {points[0]?.date.slice(5) ?? ""}
                </text>
                <text
                    x={width - pad}
                    y={height - 6}
                    textAnchor="end"
                    className="fill-muted-foreground text-[10px]"
                >
                    {points[points.length - 1]?.date.slice(5) ?? ""}
                </text>
                <text
                    x={pad}
                    y={pad - 10}
                    className="fill-muted-foreground text-[10px]"
                >
                    峰值 {max} 条
                </text>
            </svg>
        </div>
    );
};

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
            "users" | "groups" | "messages" | "files" | "tasks" | "system"
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
        const [fileRows, setFileRows] = useState<AdminFileRow[]>([]);
        const [fileTotal, setFileTotal] = useState(0);
        const [fileBytes, setFileBytes] = useState(0);
        const [fileOffset, setFileOffset] = useState(0);
        const [storage, setStorage] = useState<AdminStorageConfig | null>(null);
        const [draft, setDraft] = useState<StorageDraft | null>(null);
        const [storageMsg, setStorageMsg] = useState<string | null>(null);
        const [taskRows, setTaskRows] = useState<AdminTaskRow[]>([]);
        const [trendDays, setTrendDays] = useState(14);
        const [trend, setTrend] = useState<TrendPoint[]>([]);
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
                        rows: AdminFileRow[];
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

        const loadStorage = useCallback(() => {
            void rpc
                .call("files.config.get", {})
                .then((result) => {
                    const cfg = result as AdminStorageConfig;
                    setStorage(cfg);
                    setDraft(storageDraftOf(cfg));
                })
                .catch((err) =>
                    setError(String(err instanceof Error ? err.message : err)),
                );
        }, []);

        const loadTasks = useCallback(() => {
            void rpc
                .call("admin.tasks", {})
                .then((result) => setTaskRows(result as AdminTaskRow[]))
                .catch((err) =>
                    setError(String(err instanceof Error ? err.message : err)),
                );
        }, []);

        const loadTrend = useCallback((days: number) => {
            void rpc
                .call("admin.trend", { days })
                .then((result) => {
                    const data = result as { points: TrendPoint[] };
                    setTrend(data.points);
                })
                .catch((err) =>
                    setError(String(err instanceof Error ? err.message : err)),
                );
        }, []);

        useEffect(() => {
            if (!allowed) return;
            if (tab === "messages") loadMessages(0);
            if (tab === "files") {
                loadFiles(0);
                loadStorage();
            }
            if (tab === "tasks") loadTasks();
        }, [tab, allowed, loadMessages, loadFiles, loadStorage, loadTasks]);

        useEffect(() => {
            if (allowed && tab === "system") loadTrend(trendDays);
        }, [allowed, tab, trendDays, loadTrend]);

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

        const deleteFile = async (row: AdminFileRow) => {
            if (!confirm(`确定删除文件「${row.name}」吗？`)) return;
            try {
                await rpc.call("admin.files.delete", { key: row.key });
                loadFiles(fileOffset);
                refresh();
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            }
        };

        const saveStorage = async () => {
            if (!draft) return;
            setStorageMsg(null);
            try {
                const payload: Record<string, unknown> = {
                    driver: draft.driver,
                    dir: draft.dir.trim(),
                    uploadLimitMb: Number(draft.uploadLimitMb),
                    endpoint: draft.endpoint.trim(),
                    region: draft.region.trim(),
                    bucket: draft.bucket.trim(),
                    accessKey: draft.accessKey.trim(),
                    pathStyle: draft.pathStyle,
                    publicBase: draft.publicBase.trim(),
                };
                if (draft.secretKey) payload.secretKey = draft.secretKey;
                await rpc.call("files.config.set", payload);
                setStorageMsg("存储配置已保存");
                loadStorage();
            } catch (err) {
                setStorageMsg(String(err instanceof Error ? err.message : err));
            }
        };

        const testStorage = async () => {
            setStorageMsg("正在检测存储可用性");
            try {
                const result = (await rpc.call("files.config.test", {})) as {
                    message: string;
                };
                setStorageMsg(result.message);
            } catch (err) {
                setStorageMsg(String(err instanceof Error ? err.message : err));
            }
        };

        const runTask = async (name: string) => {
            try {
                await rpc.call("admin.task.run", { name });
                loadTasks();
                refresh();
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            }
        };

        const patchTask = async (
            name: string,
            patch: { enabled?: boolean; intervalMinutes?: number },
        ) => {
            try {
                await rpc.call("admin.task.set", { name, ...patch });
                loadTasks();
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            }
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
            { key: "tasks" as const, label: "定时任务" },
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
                            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
                                <div className="flex items-center gap-2">
                                    <HardDriveIcon className="size-4 text-muted-foreground" />
                                    <p className="text-sm font-medium">
                                        媒体存储
                                    </p>
                                    <span className="text-xs text-muted-foreground">
                                        {storage
                                            ? storage.driver === "s3"
                                                ? "S3 兼容对象存储"
                                                : "本地磁盘"
                                            : "读取中"}
                                    </span>
                                </div>
                                {draft ? (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <p className="w-24 shrink-0 text-xs text-muted-foreground">
                                                存储方式
                                            </p>
                                            <select
                                                value={draft.driver}
                                                onChange={(e) =>
                                                    setDraft({
                                                        ...draft,
                                                        driver:
                                                            e.target.value ===
                                                            "s3"
                                                                ? "s3"
                                                                : "local",
                                                    })
                                                }
                                                className="rounded-lg border border-border bg-card px-2 py-1 text-sm"
                                            >
                                                <option value="local">
                                                    本地磁盘
                                                </option>
                                                <option value="s3">
                                                    S3 兼容对象存储
                                                </option>
                                            </select>
                                            <p className="ml-auto text-xs text-muted-foreground">
                                                单文件上限
                                            </p>
                                            <Input
                                                type="number"
                                                min={1}
                                                max={1024}
                                                value={draft.uploadLimitMb}
                                                onChange={(e) =>
                                                    setDraft({
                                                        ...draft,
                                                        uploadLimitMb:
                                                            e.target.value,
                                                    })
                                                }
                                                className="h-8 w-20"
                                            />
                                            <span className="text-xs text-muted-foreground">
                                                MB
                                            </span>
                                        </div>
                                        {draft.driver === "local" ? (
                                            <div className="flex items-center gap-2">
                                                <p className="w-24 shrink-0 text-xs text-muted-foreground">
                                                    存储目录
                                                </p>
                                                <Input
                                                    value={draft.dir}
                                                    placeholder="data/uploads"
                                                    onChange={(e) =>
                                                        setDraft({
                                                            ...draft,
                                                            dir: e.target.value,
                                                        })
                                                    }
                                                    className="h-8 flex-1"
                                                />
                                            </div>
                                        ) : (
                                            <div className="grid grid-cols-2 gap-2">
                                                <StorageField
                                                    label="Endpoint"
                                                    value={draft.endpoint}
                                                    placeholder="https://s3.example.com"
                                                    onChange={(value) =>
                                                        setDraft({
                                                            ...draft,
                                                            endpoint: value,
                                                        })
                                                    }
                                                />
                                                <StorageField
                                                    label="Region"
                                                    value={draft.region}
                                                    placeholder="us-east-1"
                                                    onChange={(value) =>
                                                        setDraft({
                                                            ...draft,
                                                            region: value,
                                                        })
                                                    }
                                                />
                                                <StorageField
                                                    label="Bucket"
                                                    value={draft.bucket}
                                                    onChange={(value) =>
                                                        setDraft({
                                                            ...draft,
                                                            bucket: value,
                                                        })
                                                    }
                                                />
                                                <StorageField
                                                    label="公开访问前缀"
                                                    value={draft.publicBase}
                                                    placeholder="留空则用预签名链接"
                                                    onChange={(value) =>
                                                        setDraft({
                                                            ...draft,
                                                            publicBase: value,
                                                        })
                                                    }
                                                />
                                                <StorageField
                                                    label="Access Key"
                                                    value={draft.accessKey}
                                                    onChange={(value) =>
                                                        setDraft({
                                                            ...draft,
                                                            accessKey: value,
                                                        })
                                                    }
                                                />
                                                <StorageField
                                                    label="Secret Key"
                                                    value={draft.secretKey}
                                                    type="password"
                                                    placeholder={
                                                        storage?.secretKeySet
                                                            ? "已配置,留空表示不修改"
                                                            : ""
                                                    }
                                                    onChange={(value) =>
                                                        setDraft({
                                                            ...draft,
                                                            secretKey: value,
                                                        })
                                                    }
                                                />
                                                <label className="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
                                                    <input
                                                        type="checkbox"
                                                        checked={
                                                            draft.pathStyle
                                                        }
                                                        onChange={(e) =>
                                                            setDraft({
                                                                ...draft,
                                                                pathStyle:
                                                                    e.target
                                                                        .checked,
                                                            })
                                                        }
                                                    />
                                                    路径风格访问(MinIO
                                                    等自建服务需要开启)
                                                </label>
                                            </div>
                                        )}
                                        <div className="flex items-center gap-2">
                                            <Button
                                                size="sm"
                                                onClick={() =>
                                                    void saveStorage()
                                                }
                                            >
                                                保存
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                title="检测当前已保存的存储是否可读写"
                                                onClick={() =>
                                                    void testStorage()
                                                }
                                            >
                                                检测存储
                                            </Button>
                                            {storageMsg ? (
                                                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                                                    {storageMsg}
                                                </span>
                                            ) : null}
                                        </div>
                                    </>
                                ) : null}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                共 {fileTotal} 个文件,占用约{" "}
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
                                        key={row.key}
                                        className="flex items-center gap-3 border-b border-border px-3 py-2 text-sm last:border-b-0"
                                    >
                                        <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                                        <span className="min-w-0 flex-1 truncate">
                                            {row.name}
                                        </span>
                                        <span className="w-28 shrink-0 truncate text-xs text-muted-foreground">
                                            {row.mime}
                                        </span>
                                        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                                            {formatBytes(row.size)}
                                        </span>
                                        <span className="w-20 shrink-0 truncate text-xs text-muted-foreground">
                                            {row.uploaderName}
                                        </span>
                                        <span className="w-24 shrink-0 text-xs text-muted-foreground">
                                            {formatStamp(row.createdAt)}
                                        </span>
                                        <a
                                            href={`/files/${row.key}?download=1`}
                                            download={row.name}
                                            title="下载"
                                            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                                        >
                                            <DownloadIcon className="size-3.5" />
                                        </a>
                                        <Button
                                            size="icon-xs"
                                            variant="ghost"
                                            title="删除"
                                            onClick={() => void deleteFile(row)}
                                        >
                                            <Trash2Icon />
                                        </Button>
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
                    {tab === "tasks" ? (
                        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
                            {taskRows.length === 0 ? (
                                <p className="py-8 text-center text-xs text-muted-foreground">
                                    暂无定时任务
                                </p>
                            ) : null}
                            {taskRows.map((row) => (
                                <div
                                    key={row.name}
                                    className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4"
                                >
                                    <div className="flex items-center gap-2">
                                        <p className="text-sm font-medium">
                                            {row.title}
                                        </p>
                                        <span
                                            className={cn(
                                                "rounded-md px-1.5 py-0.5 text-xs",
                                                row.enabled
                                                    ? "bg-primary/10 text-primary"
                                                    : "bg-muted text-muted-foreground",
                                            )}
                                        >
                                            {row.enabled ? "已启用" : "已停用"}
                                        </span>
                                        <span className="ml-auto text-xs text-muted-foreground">
                                            累计执行 {row.runs} 次
                                        </span>
                                    </div>
                                    <p className="text-xs text-muted-foreground">
                                        {row.description}
                                    </p>
                                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <ClockIcon className="size-3.5" />
                                        上次执行 {formatStamp(row.lastRun)}
                                        {row.lastStatus ? (
                                            <span
                                                className={cn(
                                                    "min-w-0 truncate",
                                                    row.lastStatus === "ok"
                                                        ? "text-muted-foreground"
                                                        : "text-destructive",
                                                )}
                                            >
                                                {row.lastMessage}
                                            </span>
                                        ) : null}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-muted-foreground">
                                            执行周期
                                        </span>
                                        <Input
                                            key={`${row.name}-${row.intervalMinutes}`}
                                            type="number"
                                            min={1}
                                            max={43200}
                                            defaultValue={row.intervalMinutes}
                                            className="h-8 w-24"
                                            onBlur={(e) => {
                                                const next = Number(
                                                    e.target.value,
                                                );
                                                if (
                                                    next !== row.intervalMinutes
                                                )
                                                    void patchTask(row.name, {
                                                        intervalMinutes: next,
                                                    });
                                            }}
                                        />
                                        <span className="text-xs text-muted-foreground">
                                            分钟
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            className="ml-auto"
                                            onClick={() =>
                                                void patchTask(row.name, {
                                                    enabled: !row.enabled,
                                                })
                                            }
                                        >
                                            {row.enabled ? "停用" : "启用"}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() =>
                                                void runTask(row.name)
                                            }
                                        >
                                            <PlayIcon />
                                            立即执行
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    {tab === "system" ? (
                        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 pt-4">
                            <div className="flex items-center gap-2">
                                <p className="text-sm font-medium">数据统计</p>
                                <div className="ml-auto flex gap-1">
                                    {TREND_DAYS.map((days) => (
                                        <button
                                            key={days}
                                            type="button"
                                            className={cn(
                                                "rounded-md px-2 py-1 text-xs",
                                                trendDays === days
                                                    ? "bg-primary text-primary-foreground"
                                                    : "text-muted-foreground hover:bg-accent",
                                            )}
                                            onClick={() => setTrendDays(days)}
                                        >
                                            {days} 天
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <TrendChart points={trend} />
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
                                        媒体占用 {stats?.files ?? 0} 个文件
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
