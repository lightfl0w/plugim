import type { Context } from "@plugim/core";
import type {
    DepartmentInfo,
    DirectoryMember,
    DirectoryResult,
} from "@plugim/protocol";
import {
    ArrowLeftIcon,
    ChevronDownIcon,
    ChevronRightIcon,
    MessageSquareIcon,
    RefreshCwIcon,
} from "lucide-react";
import type { FC, MouseEvent as ReactMouseEvent } from "react";
import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    useSyncExternalStore,
} from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { InstallService } from "./ui-install";
import { displayName, openChat, setShellPane } from "./ui-shared";
import type { UiService } from "./ui-types";

const UNASSIGNED = "__unassigned__";

interface TreeNode extends DepartmentInfo {
    children: TreeNode[];
}

const buildTree = (departments: DepartmentInfo[]): TreeNode[] => {
    const nodes = new Map<string, TreeNode>();
    for (const dept of departments)
        nodes.set(dept.id, { ...dept, children: [] });
    const roots: TreeNode[] = [];
    for (const node of nodes.values()) {
        const parent = node.parentId ? nodes.get(node.parentId) : null;
        if (parent) parent.children.push(node);
        else roots.push(node);
    }
    const sortTree = (list: TreeNode[]) => {
        list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
        for (const node of list) sortTree(node.children);
    };
    sortTree(roots);
    return roots;
};

const flattenTree = (nodes: TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    const walk = (list: TreeNode[]) => {
        for (const node of list) {
            out.push(node);
            walk(node.children);
        }
    };
    walk(nodes);
    return out;
};

export const createOrgPage = (ctx: Context): FC => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const rpc = ctx.get<RpcService>("rpc");
    const friends = ctx.get<FriendsService>("friends");
    const install = ctx.get<InstallService>("install");

    const OrgPage = () => {
        const me = useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.user(),
        );
        const restoring = useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.restoring(),
        );
        const mode = useSyncExternalStore(
            (cb) => install.onChange(cb),
            () => install.status()?.mode,
        );
        const [, setFriendTick] = useState(0);
        const [data, setData] = useState<DirectoryResult | null>(null);
        const [error, setError] = useState("");
        const [loading, setLoading] = useState(true);
        const [selected, setSelected] = useState<string | null>(null);
        const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
        const [query, setQuery] = useState("");
        const navigate = useNavigate();

        useEffect(
            () => friends.onUpdate(() => setFriendTick((t) => t + 1)),
            [],
        );

        const load = useCallback(async () => {
            setLoading(true);
            setError("");
            try {
                const result = (await rpc.call(
                    "org.directory",
                    {},
                )) as DirectoryResult;
                setData(result);
            } catch (err) {
                setError(err instanceof Error ? err.message : "加载失败");
            } finally {
                setLoading(false);
            }
        }, []);

        useEffect(() => {
            void load();
        }, [load]);

        const departments = data?.departments ?? [];
        const members = data?.members ?? [];
        const tree = useMemo(() => buildTree(departments), [departments]);
        const flat = useMemo(() => flattenTree(tree), [tree]);
        const deptNames = useMemo(
            () => new Map(departments.map((dept) => [dept.id, dept.name])),
            [departments],
        );

        const scoped = useMemo(() => {
            const q = query.trim().toLowerCase();
            if (q)
                return members.filter(
                    (member) =>
                        member.username.toLowerCase().includes(q) ||
                        (member.title ?? "").toLowerCase().includes(q) ||
                        (member.deptId
                            ? (deptNames.get(member.deptId) ?? "")
                                  .toLowerCase()
                                  .includes(q)
                            : false),
                );
            if (selected === null) return members;
            if (selected === UNASSIGNED)
                return members.filter((member) => !member.deptId);
            const scope = new Set<string>([selected]);
            const queue = [selected];
            while (queue.length > 0) {
                const current = queue.shift();
                if (!current) break;
                for (const dept of departments) {
                    if (dept.parentId !== current || scope.has(dept.id))
                        continue;
                    scope.add(dept.id);
                    queue.push(dept.id);
                }
            }
            return members.filter(
                (member) => member.deptId && scope.has(member.deptId),
            );
        }, [members, departments, deptNames, selected, query]);

        const sorted = useMemo(
            () =>
                [...scoped].sort((a, b) => {
                    if (a.online !== b.online) return a.online ? -1 : 1;
                    return a.username.localeCompare(b.username);
                }),
            [scoped],
        );

        const unassignedCount = useMemo(
            () => members.filter((member) => !member.deptId).length,
            [members],
        );

        const toggleCollapse = (id: string) => {
            setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
        };

        const startChat = (member: DirectoryMember) => {
            openChat(ctx, {
                session: `p2p:${member.username}`,
                title: displayName(member.username, friends.cached()?.remarks),
            });
            setShellPane("chat");
            navigate("/chat");
        };

        const openCard = (member: DirectoryMember, e: ReactMouseEvent) => {
            ctx.emit("ui:profile:open", {
                username: member.username,
                x: e.clientX,
                y: e.clientY,
            });
        };

        const select = (id: string | null) => {
            setQuery("");
            setSelected(id);
        };

        if (mode === "chat") return <Navigate to="/chat" replace />;
        if (restoring && !me) return null;
        if (!me) return <Navigate to="/login" replace />;

        const DeptNode = ({
            node,
            depth,
        }: {
            node: TreeNode;
            depth: number;
        }) => {
            const active = selected === node.id && !query;
            const isCollapsed = collapsed.has(node.id);
            return (
                <div>
                    <div
                        className={cn(
                            "group flex cursor-pointer items-center gap-1 rounded-md pr-2 text-sm transition-colors hover:bg-accent",
                            active && "bg-accent text-foreground",
                        )}
                        style={{ paddingLeft: `${depth * 12 + 4}px` }}
                        onClick={() => select(node.id)}
                    >
                        <button
                            type="button"
                            className={cn(
                                "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground",
                                node.children.length === 0 && "invisible",
                            )}
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleCollapse(node.id);
                            }}
                        >
                            {isCollapsed ? (
                                <ChevronRightIcon className="size-3.5" />
                            ) : (
                                <ChevronDownIcon className="size-3.5" />
                            )}
                        </button>
                        <span className="min-w-0 flex-1 truncate py-1.5">
                            {node.name}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                            {node.memberCount}
                        </span>
                    </div>
                    {isCollapsed
                        ? null
                        : node.children.map((child) => (
                              <DeptNode
                                  key={child.id}
                                  node={child}
                                  depth={depth + 1}
                              />
                          ))}
                </div>
            );
        };

        const MemberRow = ({ member }: { member: DirectoryMember }) => {
            const label = displayName(
                member.username,
                friends.cached()?.remarks,
            );
            const meta = [
                member.deptId ? deptNames.get(member.deptId) : null,
                member.title,
            ]
                .filter(Boolean)
                .join(" · ");
            return (
                <div
                    className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent"
                    onClick={(e) => openCard(member, e)}
                >
                    <span className="relative shrink-0">
                        <UserAvatar name={member.username} />
                        <span
                            title={member.online ? "在线" : "离线"}
                            className={cn(
                                "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background",
                                member.online
                                    ? "bg-emerald-500"
                                    : "bg-gray-300",
                            )}
                        />
                    </span>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{label}</p>
                        <p className="truncate text-xs text-muted-foreground">
                            {meta || "未设置部门职位"}
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 max-md:opacity-100"
                        onClick={(e) => {
                            e.stopPropagation();
                            startChat(member);
                        }}
                    >
                        <MessageSquareIcon />
                        发消息
                    </Button>
                </div>
            );
        };

        const scopeLabel = query
            ? `搜索到 ${sorted.length} 人`
            : selected === UNASSIGNED
              ? `未分配 ${sorted.length} 人`
              : selected
                ? `${deptNames.get(selected) ?? ""} ${sorted.length} 人（含子部门）`
                : `全部成员 ${sorted.length} 人`;

        return (
            <div className="relative flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-2 border-b border-border px-3">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="返回"
                        onClick={() => void navigate(-1)}
                    >
                        <ArrowLeftIcon />
                    </Button>
                    <p className="shrink-0 text-sm font-semibold">通讯录</p>
                    <div className="ml-2 min-w-0 flex-1 md:max-w-xs">
                        <Input
                            value={query}
                            placeholder="搜索姓名、职位或部门"
                            className="h-8"
                            onChange={(e) => setQuery(e.target.value)}
                        />
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto"
                        title="刷新"
                        disabled={loading}
                        onClick={() => void load()}
                    >
                        <RefreshCwIcon
                            className={cn(loading && "animate-spin")}
                        />
                    </Button>
                </div>
                <div className="flex min-h-0 flex-1">
                    <aside className="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2 md:flex">
                        <div
                            className={cn(
                                "cursor-pointer rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                                selected === null &&
                                    !query &&
                                    "bg-accent text-foreground",
                            )}
                            onClick={() => select(null)}
                        >
                            全部成员
                            <span className="ml-1 text-xs text-muted-foreground">
                                {members.length}
                            </span>
                        </div>
                        <div
                            className={cn(
                                "cursor-pointer rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent",
                                selected === UNASSIGNED &&
                                    !query &&
                                    "bg-accent text-foreground",
                            )}
                            onClick={() => select(UNASSIGNED)}
                        >
                            未分配
                            <span className="ml-1 text-xs text-muted-foreground">
                                {unassignedCount}
                            </span>
                        </div>
                        <div className="my-1 h-px bg-border" />
                        {flat.length === 0 ? (
                            <p className="px-2 py-1.5 text-xs text-muted-foreground">
                                还没有部门
                            </p>
                        ) : (
                            tree.map((node) => (
                                <DeptNode key={node.id} node={node} depth={0} />
                            ))
                        )}
                    </aside>
                    <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex gap-1.5 overflow-x-auto border-b border-border p-2 md:hidden">
                            <button
                                type="button"
                                className={cn(
                                    "shrink-0 rounded-full border border-border px-3 py-1 text-xs",
                                    selected === null &&
                                        !query &&
                                        "border-primary text-primary",
                                )}
                                onClick={() => select(null)}
                            >
                                全部
                            </button>
                            <button
                                type="button"
                                className={cn(
                                    "shrink-0 rounded-full border border-border px-3 py-1 text-xs",
                                    selected === UNASSIGNED &&
                                        !query &&
                                        "border-primary text-primary",
                                )}
                                onClick={() => select(UNASSIGNED)}
                            >
                                未分配
                            </button>
                            {flat.map((dept) => (
                                <button
                                    key={dept.id}
                                    type="button"
                                    className={cn(
                                        "shrink-0 rounded-full border border-border px-3 py-1 text-xs",
                                        selected === dept.id &&
                                            !query &&
                                            "border-primary text-primary",
                                    )}
                                    onClick={() => select(dept.id)}
                                >
                                    {dept.name}
                                </button>
                            ))}
                        </div>
                        <div className="flex items-center justify-between px-3 pt-2 text-xs text-muted-foreground">
                            <span>{scopeLabel}</span>
                        </div>
                        <div className="min-h-0 flex-1 overflow-y-auto p-2">
                            {sorted.length === 0 ? (
                                <p className="py-10 text-center text-sm text-muted-foreground">
                                    {loading ? "加载中…" : "没有匹配的成员"}
                                </p>
                            ) : (
                                sorted.map((member) => (
                                    <MemberRow
                                        key={member.id}
                                        member={member}
                                    />
                                ))
                            )}
                            {error ? (
                                <p className="py-2 text-center text-xs text-red-500">
                                    {error}
                                </p>
                            ) : null}
                        </div>
                    </div>
                </div>
                <ui.Slot
                    slot="overlay"
                    className="pointer-events-none absolute inset-0 z-10"
                />
            </div>
        );
    };

    return OrgPage;
};
