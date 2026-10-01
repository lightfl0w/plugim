import type { Context } from "@plugim/core";
import type {
    ChatMessage,
    FriendListResult,
    GroupInfo,
} from "@plugim/protocol";
import { MENTION_ALL } from "@plugim/protocol";
import {
    ApertureIcon,
    BellIcon,
    BellOffIcon,
    CheckIcon,
    LogOutIcon,
    MessageSquarePlusIcon,
    MessagesSquareIcon,
    PictureInPicture2Icon,
    PlusIcon,
    ShieldIcon,
    UserRoundIcon,
    UsersIcon,
    XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { CacheService, SessionPreview } from "./cache";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { GroupsService } from "./groups";
import type { MomentsService } from "./moments";
import type { PresenceService } from "./presence";
import type { AdminService } from "./ui-admin";
import { draftKey, draftStore } from "./ui-drafts";
import {
    clientSessionOf,
    currentChatTarget,
    displayName,
    isPopupWindow,
    longPressMenu,
    messageLabel,
    openChat,
    openDetachedChat,
    PRESENCE_STATUS_OPTIONS,
    playBeep,
    presenceStatusMeta,
    setShellPane,
    showAlert,
    usePopupClose,
} from "./ui-shared";
import type { UiService } from "./ui-types";

const BASE_TITLE = "plugim";

const previewText = (
    content: string,
    kind?: string,
    fileName?: string | null,
) =>
    content.startsWith('{"merge":1')
        ? "[聊天记录]"
        : (messageLabel(kind, content, fileName) ??
          content.replace(/\s+/g, " "));

function previewTime(at: number): string {
    const d = new Date(at);
    const now = new Date();
    const startOf = (x: Date) =>
        new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
    if (diffDays === 0)
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (diffDays === 1) return "昨天";
    if (diffDays < 7) return `星期${"日一二三四五六"[d.getDay()]}`;
    if (d.getFullYear() === now.getFullYear())
        return `${d.getMonth() + 1}月${d.getDate()}日`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

const AVATAR_PALETTE = [
    "bg-rose-500",
    "bg-orange-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-teal-500",
    "bg-sky-500",
    "bg-indigo-500",
    "bg-violet-500",
    "bg-fuchsia-500",
];

function hashName(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return Math.abs(h);
}

const GroupAvatar = ({ name }: { name: string }) => (
    <span
        className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg text-base font-semibold text-white",
            AVATAR_PALETTE[hashName(name) % AVATAR_PALETTE.length],
        )}
    >
        {name.slice(0, 1).toUpperCase()}
    </span>
);

const dndKey = (owner: string) => `plugim_dnd:${owner}`;

const loadDnd = (owner: string): string[] => {
    try {
        const raw = localStorage.getItem(dndKey(owner));
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(parsed)
            ? parsed.filter((x): x is string => typeof x === "string")
            : [];
    } catch {
        return [];
    }
};

function NavIcon({
    to,
    icon,
    label,
    onOpen,
    badge = 0,
}: {
    to: string;
    icon: ReactNode;
    label: string;
    onOpen?: () => void;
    badge?: number;
}) {
    return (
        <NavLink
            to={to}
            title={label}
            onClick={onOpen}
            className={({ isActive }) =>
                cn(
                    "relative flex size-10 items-center justify-center rounded-lg",
                    isActive
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
            }
        >
            {icon}
            {badge > 0 ? (
                <span
                    title={`${badge} 条未读动态`}
                    className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] leading-4 font-medium text-white"
                >
                    {badge > 99 ? "99+" : badge}
                </span>
            ) : null}
        </NavLink>
    );
}

interface SessionRowMenuRequest {
    x: number;
    y: number;
    session: string;
    label: string;
}

interface SessionRowActions {
    open: (session: string, label: string) => void;
    openMenu: (request: SessionRowMenuRequest) => void;
}

interface SessionsRowProps {
    session: string;
    label: string;
    isGroup: boolean;
    pending: number;
    active: boolean;
    pinned: boolean;
    muted: boolean;
    mentioned: boolean;
    count: number;
    draftText: string;
    preview: SessionPreview | undefined;
    peerName: string | null;
    peerOnline: boolean;
    actions: SessionRowActions;
}

const SessionsRow = memo(function SessionsRow({
    session,
    label,
    isGroup,
    pending,
    active,
    pinned,
    muted,
    mentioned,
    count,
    draftText,
    preview,
    peerName,
    peerOnline,
    actions,
}: SessionsRowProps) {
    return (
        <button
            type="button"
            onClick={() => actions.open(session, label)}
            onContextMenu={(e) => {
                e.preventDefault();
                actions.openMenu({
                    x: e.clientX,
                    y: e.clientY,
                    session,
                    label,
                });
            }}
            {...longPressMenu((x, y) =>
                actions.openMenu({ x, y, session, label }),
            )}
            className={cn(
                "flex w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                active ? "bg-chat-item-active" : "hover:bg-muted/70",
            )}
        >
            {isGroup ? (
                <GroupAvatar name={label} />
            ) : (
                <span className="relative shrink-0">
                    <UserAvatar name={peerName ?? label} className="size-10" />
                    {peerOnline ? (
                        <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
                    ) : null}
                </span>
            )}
            <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                        {pinned ? <PinIconInline /> : null}
                        {label}
                        {muted ? (
                            <BellOffIcon className="ml-1 inline size-3 text-muted-foreground" />
                        ) : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                        {preview ? previewTime(preview.at) : ""}
                    </span>
                </span>
                <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {pending > 0 ? (
                            <span className="mr-1 text-amber-600 dark:text-amber-400">
                                [{pending} 条加群申请]
                            </span>
                        ) : null}
                        {mentioned ? (
                            <span className="mr-1 text-red-500">[@我]</span>
                        ) : null}
                        {draftText.trim() ? (
                            <>
                                <span className="mr-1 text-amber-600 dark:text-amber-400">
                                    [草稿]
                                </span>
                                {draftText.replace(/\s+/g, " ")}
                            </>
                        ) : preview ? (
                            previewText(preview.content, preview.kind)
                        ) : (
                            "暂无消息"
                        )}
                    </span>
                    {count > 0 ? (
                        <span
                            className={cn(
                                "flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] leading-none font-medium text-white",
                                muted ? "bg-gray-400" : "bg-red-500",
                            )}
                        >
                            {count > 99 ? "99+" : count}
                        </span>
                    ) : null}
                </span>
            </span>
        </button>
    );
});

export const uiSidebarSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const friends = ctx.get<FriendsService>("friends");
    const groups = ctx.get<GroupsService>("groups");
    const cache = ctx.get<CacheService>("cache");
    const presence = ctx.get<PresenceService>("presence");
    const rpc = ctx.get<RpcService>("rpc");
    const adminService = ctx.get<AdminService>("admin");
    const moments = ctx.get<MomentsService>("moments");

    const StatusMenu = ({ username }: { username: string }) => {
        const [open, setOpen] = useState(false);
        const status = useSyncExternalStore(
            (cb) => presence.onChange(cb),
            () => presence.myStatus(),
        );
        const ref = useRef<HTMLDivElement>(null);
        usePopupClose(ref, open, () => setOpen(false));
        const meta = presenceStatusMeta(status);
        return (
            <div ref={ref} className="relative">
                <button
                    type="button"
                    title={`状态：${meta.label}`}
                    className="relative block rounded-full"
                    onClick={() => setOpen((v) => !v)}
                >
                    <UserAvatar name={username} size="sm" />
                    <span
                        className={cn(
                            "absolute right-0 bottom-0 size-2.5 rounded-full ring-2 ring-background",
                            meta.dot,
                        )}
                    />
                </button>
                {open ? (
                    <div className="absolute bottom-0 left-full z-50 ml-2 w-32 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-lg">
                        {PRESENCE_STATUS_OPTIONS.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                className={cn(
                                    "flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent",
                                    status === option.value &&
                                        "text-primary font-medium",
                                )}
                                onClick={() => {
                                    void presence.setMyStatus(option.value);
                                    setOpen(false);
                                }}
                            >
                                <span
                                    className={cn(
                                        "size-2 rounded-full",
                                        option.dot,
                                    )}
                                />
                                {option.label}
                            </button>
                        ))}
                        <div className="my-1 border-t border-border" />
                        <NavLink
                            to="/me"
                            onClick={() => setOpen(false)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                        >
                            <span className="flex size-2 items-center justify-center">
                                <UserRoundIcon className="size-3 text-muted-foreground" />
                            </span>
                            用户中心
                        </NavLink>
                    </div>
                ) : null}
            </div>
        );
    };

    const Nav = () => {
        const user = useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.user(),
        );
        const admin = useSyncExternalStore(
            (cb) => adminService.onChange(cb),
            () => adminService.is(),
        );
        const momentsUnread = useSyncExternalStore(
            (cb) => moments.onUpdate(cb),
            () => moments.state().unread.total,
        );
        return (
            <>
                <NavIcon
                    to="/chat"
                    icon={<MessagesSquareIcon className="size-5" />}
                    label="聊天"
                    onOpen={() => setShellPane("list")}
                />
                <NavIcon
                    to="/friends"
                    icon={<UsersIcon className="size-5" />}
                    label="好友"
                    onOpen={() => setShellPane("list")}
                />
                <NavIcon
                    to="/moments"
                    icon={<ApertureIcon className="size-5" />}
                    label="朋友圈"
                    badge={momentsUnread}
                />
                <div className="flex items-center gap-1 md:mt-auto md:flex-col">
                    {user ? <StatusMenu username={user.username} /> : null}
                    {admin ? (
                        <NavLink
                            to="/admin"
                            title="后台管理"
                            className={({ isActive }) =>
                                cn(
                                    "flex size-9 shrink-0 items-center justify-center rounded-[min(var(--radius-md),12px)] transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
                                    isActive && "bg-muted text-foreground",
                                )
                            }
                        >
                            <ShieldIcon className="size-4" />
                        </NavLink>
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
        const [list, setList] = useState<FriendListResult | null>(
            friends.cached(),
        );
        const [groupList, setGroupList] = useState<GroupInfo[] | null>(
            groups.cached(),
        );
        const [active, setActive] = useState(currentChatTarget().session);
        const [unread, setUnread] = useState<Record<string, number>>({});
        const [previews, setPreviews] = useState<
            Record<string, SessionPreview>
        >({});
        const [pinned, setPinned] = useState<string[]>([]);
        const [dnd, setDnd] = useState<string[]>([]);
        const [mentioned, setMentioned] = useState<Record<string, boolean>>({});
        const draftMap = useSyncExternalStore(
            draftStore.subscribe,
            draftStore.snapshot,
        );
        const [query, setQuery] = useState("");
        const [hits, setHits] = useState<ChatMessage[]>([]);
        const [hitsTotal, setHitsTotal] = useState(0);
        const [searching, setSearching] = useState(false);
        const [sessionMenu, setSessionMenu] = useState<{
            x: number;
            y: number;
            session: string;
            label: string;
        } | null>(null);
        const [createOpen, setCreateOpen] = useState(false);
        const [plusOpen, setPlusOpen] = useState(false);
        const [groupName, setGroupName] = useState("");
        const [invitees, setInvitees] = useState<string[]>([]);
        const [creating, setCreating] = useState(false);
        const activeRef = useRef(active);
        const unreadRef = useRef<Record<string, number>>({});
        const previewsRef = useRef<Record<string, SessionPreview>>({});
        const dndRef = useRef<string[]>([]);
        const plusWrapRef = useRef<HTMLDivElement>(null);
        const createCardRef = useRef<HTMLDivElement>(null);
        const sessionMenuRef = useRef<HTMLDivElement>(null);
        const nameInputRef = useRef<HTMLInputElement>(null);
        const searchTimerRef = useRef<
            ReturnType<typeof setTimeout> | undefined
        >(undefined);
        const navigate = useNavigate();
        const me = auth.user()?.username ?? "";
        const [, setPresenceTick] = useState(0);
        useEffect(
            () => presence.onChange(() => setPresenceTick((t) => t + 1)),
            [],
        );

        const applyUnread = useCallback(
            (next: Record<string, number>) => {
                unreadRef.current = next;
                setUnread(next);
                if (me) void cache.setUnread(me, next).catch(() => undefined);
                const total = Object.entries(next).reduce(
                    (sum, [session, n]) =>
                        dndRef.current.includes(session) ? sum : sum + n,
                    0,
                );
                document.title =
                    total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
            },
            [me],
        );

        const applyPreview = useCallback((message: ChatMessage) => {
            const at = Date.parse(message.createdAt);
            const current = previewsRef.current[message.session];
            if (current && current.at > at) return;
            const next = {
                ...previewsRef.current,
                [message.session]: {
                    id: message.id,
                    sender: message.sender,
                    content: message.recalledAt
                        ? "[消息已撤回]"
                        : message.content,
                    at,
                    kind: message.kind,
                },
            };
            previewsRef.current = next;
            setPreviews(next);
        }, []);

        const togglePin = useCallback(
            (session: string) => {
                setPinned((prev) => {
                    const next = prev.includes(session)
                        ? prev.filter((s) => s !== session)
                        : [...prev, session];
                    if (me)
                        void cache.setPinned(me, next).catch(() => undefined);
                    return next;
                });
            },
            [me],
        );

        const toggleDnd = useCallback(
            (session: string) => {
                setDnd((prev) => {
                    const next = prev.includes(session)
                        ? prev.filter((s) => s !== session)
                        : [...prev, session];
                    dndRef.current = next;
                    if (me)
                        localStorage.setItem(dndKey(me), JSON.stringify(next));
                    return next;
                });
            },
            [me],
        );

        useEffect(() => {
            if (!me) return;
            void cache
                .getUnread(me)
                .then((saved) => {
                    if (Object.keys(saved).length === 0) return;
                    applyUnread(saved);
                })
                .catch(() => undefined);
            void cache
                .getPreviews(me)
                .then((saved) => {
                    previewsRef.current = saved;
                    setPreviews(saved);
                })
                .catch(() => undefined);
            void cache
                .getPinned(me)
                .then(setPinned)
                .catch(() => undefined);
            const savedDnd = loadDnd(me);
            dndRef.current = savedDnd;
            setDnd(savedDnd);
        }, [me, applyUnread]);

        useEffect(() => {
            const disposeOpen = ctx.on("ui:chat:open", (payload) => {
                const session = (payload as { session: string }).session;
                activeRef.current = session;
                setActive(session);
                const current = unreadRef.current;
                if (current[session]) {
                    const { [session]: _drop, ...rest } = current;
                    applyUnread(rest);
                }
                setMentioned((prev) => {
                    if (!prev[session]) return prev;
                    const { [session]: _drop, ...rest } = prev;
                    return rest;
                });
            });
            const disposeMsg = ctx.on("server:message:new", (payload) => {
                const message = (payload as { message: ChatMessage }).message;
                applyPreview(message);
                if (message.sender === auth.user()?.username) return;
                if (
                    message.mentions?.includes(auth.user()?.username ?? "") ||
                    message.mentions?.includes(MENTION_ALL)
                ) {
                    setMentioned((prev) => ({
                        ...prev,
                        [message.session]: true,
                    }));
                }
                const starHit =
                    message.session.startsWith("p2p:") &&
                    (friends.cached()?.starred ?? []).includes(message.sender);
                if (starHit || !dndRef.current.includes(message.session))
                    playBeep();
                if (message.session === activeRef.current) return;
                applyUnread({
                    ...unreadRef.current,
                    [message.session]:
                        (unreadRef.current[message.session] ?? 0) + 1,
                });
                notifyInBackground(message, dndRef.current, starHit);
            });
            const disposeRecall = ctx.on(
                "server:message:recalled",
                (payload) => {
                    const { id, session } = payload as {
                        id: string;
                        session: string;
                    };
                    const current = previewsRef.current[session];
                    if (!current || current.id !== id) return;
                    const next = {
                        ...previewsRef.current,
                        [session]: { ...current, content: "[消息已撤回]" },
                    };
                    previewsRef.current = next;
                    setPreviews(next);
                },
            );
            const disposePresence = ctx.on(
                "server:presence:update",
                (payload) => {
                    const { username, online } = payload as {
                        username: string;
                        online: boolean;
                    };
                    if (!online) return;
                    if (username === auth.user()?.username) return;
                    if (!(friends.cached()?.starred ?? []).includes(username))
                        return;
                    playBeep();
                    if (
                        typeof Notification !== "undefined" &&
                        Notification.permission === "granted" &&
                        document.visibilityState === "hidden"
                    ) {
                        try {
                            new Notification("特别关心", {
                                body: `${username} 上线了`,
                                tag: `presence:${username}`,
                            });
                        } catch {}
                    }
                },
            );
            return () => {
                void disposeOpen();
                void disposeMsg();
                void disposeRecall();
                void disposePresence();
            };
        }, [applyUnread, applyPreview]);

        useEffect(() => {
            setList(friends.cached());
            void friends.refresh().catch(() => undefined);
            return friends.onUpdate(() => setList(friends.cached()));
        }, []);

        useEffect(() => {
            setGroupList(groups.cached());
            return groups.onUpdate(() => setGroupList(groups.cached()));
        }, []);

        usePopupClose(
            sessionMenuRef,
            !!sessionMenu,
            () => setSessionMenu(null),
            true,
        );
        usePopupClose(
            [plusWrapRef, createCardRef],
            plusOpen || createOpen,
            () => {
                setPlusOpen(false);
                setCreateOpen(false);
            },
        );

        useEffect(() => {
            if (createOpen) nameInputRef.current?.focus();
        }, [createOpen]);

        useEffect(() => {
            const keyword = query.trim();
            clearTimeout(searchTimerRef.current);
            if (!keyword) {
                setHits([]);
                setHitsTotal(0);
                setSearching(false);
                return undefined;
            }
            setSearching(true);
            searchTimerRef.current = setTimeout(() => {
                void rpc
                    .call("message.search", { keyword, limit: 50 })
                    .then((result) => {
                        const data = result as {
                            hits: ChatMessage[];
                            total: number;
                        };
                        setHits(data.hits);
                        setHitsTotal(data.total);
                    })
                    .catch(() => {
                        setHits([]);
                        setHitsTotal(0);
                    })
                    .finally(() => setSearching(false));
            }, 250);
            return () => clearTimeout(searchTimerRef.current);
        }, [query]);

        const openSession = (session: string, label: string) => {
            openChat(ctx, { session, title: label });
            setShellPane("chat");
            navigate("/chat");
        };

        const actionsRef = useRef<SessionRowActions | null>(null);
        actionsRef.current = {
            open: openSession,
            openMenu: setSessionMenu,
        };
        const rowActions = useMemo<SessionRowActions>(
            () => ({
                open: (session, label) =>
                    actionsRef.current?.open(session, label),
                openMenu: (request) => actionsRef.current?.openMenu(request),
            }),
            [],
        );

        const labelOf = (session: string) => {
            if (session === "general") return "综合频道";
            if (session.startsWith("g:"))
                return (
                    groupList?.find((group) => `g:${group.id}` === session)
                        ?.name ?? "群聊"
                );
            return displayName(session.slice(4), list?.remarks);
        };

        const entries = [
            {
                session: "general",
                label: "综合频道",
                isGroup: false,
                pending: 0,
            },
            ...(groupList ?? []).map((group) => ({
                session: `g:${group.id}`,
                label: group.name,
                isGroup: true,
                pending: group.pendingRequests,
            })),
            ...(list?.friends ?? []).map((name) => ({
                session: `p2p:${name}`,
                label: displayName(name, list?.remarks),
                isGroup: false,
                pending: 0,
            })),
        ].sort((a, b) => {
            const pinDiff =
                Number(pinned.includes(b.session)) -
                Number(pinned.includes(a.session));
            if (pinDiff !== 0) return pinDiff;
            const atA = previews[a.session]?.at ?? 0;
            const atB = previews[b.session]?.at ?? 0;
            return atB - atA;
        });

        const submitCreate = async () => {
            const name = groupName.trim();
            if (name.length < 2 || creating) return;
            setCreating(true);
            try {
                const info = (await rpc.call("group.create", {
                    name,
                    members: invitees,
                })) as GroupInfo;
                setCreateOpen(false);
                setGroupName("");
                setInvitees([]);
                openSession(`g:${info.id}`, info.name);
            } catch (err) {
                showAlert(
                    String(err instanceof Error ? err.message : err),
                    "出错了",
                );
            } finally {
                setCreating(false);
            }
        };

        const menuButton = (
            key: string,
            icon: ReactNode,
            label: string,
            onClick: () => void,
        ) => (
            <button
                key={key}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                    setSessionMenu(null);
                    onClick();
                }}
            >
                {icon}
                {label}
            </button>
        );

        return (
            <>
                <div className="flex h-12 min-h-12 items-center gap-2 px-3">
                    <div className="relative w-full">
                        <input
                            value={query}
                            placeholder="搜索"
                            className="h-7 w-full rounded-md bg-muted px-2.5 pr-6 text-xs outline-none placeholder:text-muted-foreground"
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Escape") setQuery("");
                            }}
                        />
                        {query ? (
                            <button
                                type="button"
                                title="清空"
                                className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                                onClick={() => setQuery("")}
                            >
                                <XIcon className="size-3" />
                            </button>
                        ) : null}
                    </div>
                    <div className="relative" ref={plusWrapRef}>
                        <button
                            type="button"
                            title="新建"
                            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            onClick={() => setPlusOpen((v) => !v)}
                        >
                            <PlusIcon className="size-4" />
                        </button>
                        {plusOpen ? (
                            <div
                                role="menu"
                                className="absolute top-8 left-0 z-40 w-36 rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
                            >
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                                    onClick={() => {
                                        setPlusOpen(false);
                                        setCreateOpen(true);
                                    }}
                                >
                                    <MessageSquarePlusIcon className="size-4" />
                                    新建群聊
                                </button>
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2">
                    {query.trim() ? (
                        <>
                            <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
                                {searching
                                    ? "正在搜索..."
                                    : `找到 ${hitsTotal} 条消息`}
                            </p>
                            {hits.map((hit) => {
                                const client = clientSessionOf(hit.session, me);
                                const label = labelOf(client);
                                return (
                                    <button
                                        key={hit.id}
                                        type="button"
                                        className="flex w-full shrink-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left hover:bg-muted/70"
                                        onClick={() => {
                                            setQuery("");
                                            openSession(client, label);
                                            ctx.emit("ui:chat:search:jump", {
                                                session: client,
                                                id: hit.id,
                                                at: hit.createdAt,
                                            });
                                        }}
                                    >
                                        <span className="flex items-baseline justify-between gap-2">
                                            <span className="min-w-0 truncate text-sm font-medium">
                                                {label}
                                            </span>
                                            <span className="shrink-0 text-[11px] text-muted-foreground">
                                                {previewTime(
                                                    Date.parse(hit.createdAt),
                                                )}
                                            </span>
                                        </span>
                                        <span className="truncate text-xs text-muted-foreground">
                                            {hit.sender}：
                                            {previewText(
                                                hit.content,
                                                hit.kind,
                                                hit.file?.name,
                                            )}
                                        </span>
                                    </button>
                                );
                            })}
                            {!searching && hits.length === 0 ? (
                                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                    没有匹配的消息
                                </p>
                            ) : null}
                        </>
                    ) : (
                        <>
                            {entries.map((entry) => (
                                <SessionsRow
                                    key={entry.session}
                                    session={entry.session}
                                    label={entry.label}
                                    isGroup={entry.isGroup}
                                    pending={entry.pending}
                                    active={active === entry.session}
                                    pinned={pinned.includes(entry.session)}
                                    muted={dnd.includes(entry.session)}
                                    mentioned={!!mentioned[entry.session]}
                                    count={unread[entry.session] ?? 0}
                                    draftText={
                                        draftMap[draftKey(me, entry.session)] ??
                                        ""
                                    }
                                    preview={previews[entry.session]}
                                    peerName={
                                        entry.session.startsWith("p2p:")
                                            ? entry.session.slice(4)
                                            : null
                                    }
                                    peerOnline={
                                        entry.session.startsWith("p2p:")
                                            ? presence.isOnline(
                                                  entry.session.slice(4),
                                              )
                                            : false
                                    }
                                    actions={rowActions}
                                />
                            ))}
                            {entries.length === 0 ? (
                                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                    还没有会话，去好友页添加好友或右上角新建群聊
                                </p>
                            ) : null}
                        </>
                    )}
                </div>
                {sessionMenu ? (
                    <div
                        ref={sessionMenuRef}
                        role="menu"
                        className="fixed z-50 w-36 rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
                        style={{
                            left: Math.min(
                                sessionMenu.x,
                                window.innerWidth - 160,
                            ),
                            top: Math.min(
                                sessionMenu.y,
                                window.innerHeight - 160,
                            ),
                        }}
                    >
                        {menuButton(
                            "pin",
                            <PinIconInline />,
                            pinned.includes(sessionMenu.session)
                                ? "取消置顶"
                                : "置顶会话",
                            () => togglePin(sessionMenu.session),
                        )}
                        {menuButton(
                            "dnd",
                            dnd.includes(sessionMenu.session) ? (
                                <BellIcon className="size-4" />
                            ) : (
                                <BellOffIcon className="size-4" />
                            ),
                            dnd.includes(sessionMenu.session)
                                ? "取消免打扰"
                                : "消息免打扰",
                            () => toggleDnd(sessionMenu.session),
                        )}
                        {(unread[sessionMenu.session] ?? 0) > 0
                            ? menuButton(
                                  "read",
                                  <CheckIcon className="size-4" />,
                                  "清除未读",
                                  () => {
                                      const {
                                          [sessionMenu.session]: _drop,
                                          ...rest
                                      } = unreadRef.current;
                                      applyUnread(rest);
                                  },
                              )
                            : null}
                        {isPopupWindow()
                            ? null
                            : menuButton(
                                  "window",
                                  <PictureInPicture2Icon className="size-4" />,
                                  "独立窗口打开",
                                  () => openDetachedChat(sessionMenu.session),
                              )}
                    </div>
                ) : null}
                {createOpen ? (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                        <div
                            ref={createCardRef}
                            role="dialog"
                            aria-label="新建群聊"
                            className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-card shadow-xl"
                        >
                            <div className="flex items-center border-b border-border px-4 py-3">
                                <p className="flex-1 text-sm font-semibold">
                                    新建群聊
                                </p>
                                <button
                                    type="button"
                                    title="关闭"
                                    className="rounded-md p-1 hover:bg-accent"
                                    onClick={() => setCreateOpen(false)}
                                >
                                    <XIcon className="size-4" />
                                </button>
                            </div>
                            <div className="flex flex-col gap-3 p-4">
                                <input
                                    ref={nameInputRef}
                                    value={groupName}
                                    placeholder="群名称（至少 2 个字符）"
                                    maxLength={32}
                                    className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm outline-none focus:border-primary"
                                    onChange={(e) =>
                                        setGroupName(e.target.value)
                                    }
                                />
                                <p className="text-xs text-muted-foreground">
                                    邀请好友
                                </p>
                                <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
                                    {(list?.friends ?? []).length === 0 ? (
                                        <p className="p-3 text-xs text-muted-foreground">
                                            暂无好友可邀请
                                        </p>
                                    ) : null}
                                    {(list?.friends ?? []).map((name) => (
                                        <label
                                            key={name}
                                            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/60"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={invitees.includes(
                                                    name,
                                                )}
                                                onChange={(e) =>
                                                    setInvitees((prev) =>
                                                        e.target.checked
                                                            ? [...prev, name]
                                                            : prev.filter(
                                                                  (x) =>
                                                                      x !==
                                                                      name,
                                                              ),
                                                    )
                                                }
                                            />
                                            <UserAvatar name={name} size="sm" />
                                            <span className="truncate">
                                                {name}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            </div>
                            <div className="flex justify-end gap-2 border-t border-border p-3">
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setCreateOpen(false)}
                                >
                                    取消
                                </Button>
                                <Button
                                    size="sm"
                                    disabled={
                                        groupName.trim().length < 2 || creating
                                    }
                                    onClick={() => void submitCreate()}
                                >
                                    {creating ? "创建中" : "创建"}
                                </Button>
                            </div>
                        </div>
                    </div>
                ) : null}
            </>
        );
    };

    const unregisterNav = ui.register("nav", Nav);
    const unregisterSidebar = ui.register("sidebar", Sessions);
    return () => {
        unregisterNav();
        unregisterSidebar();
    };
};

const PinIconInline = () => (
    <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        role="img"
        aria-label="置顶"
        className="mr-1 inline size-3 text-muted-foreground"
    >
        <path d="M12 17v5" />
        <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
);

const notifyInBackground = (
    message: ChatMessage,
    dnd: string[],
    starred = false,
) => {
    if (document.visibilityState !== "hidden") return;
    if (!starred && dnd.includes(message.session)) return;
    if (
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
    )
        return;
    try {
        new Notification(
            starred ? `特别关心：${message.sender}` : message.sender,
            {
                body: previewText(message.content, message.kind).slice(0, 80),
                tag: message.session,
            },
        );
    } catch {}
};
