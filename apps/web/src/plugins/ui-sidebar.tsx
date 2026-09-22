import type { Plugin } from "@plugim/core";
import type {
    ChatMessage,
    FriendListResult,
    GroupInfo,
} from "@plugim/protocol";
import {
    BellIcon,
    BellOffIcon,
    CheckIcon,
    LogOutIcon,
    MessageSquarePlusIcon,
    MessagesSquareIcon,
    PlusIcon,
    UsersIcon,
    XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
    useCallback,
    useEffect,
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
import type { PresenceService } from "./presence";
import type { UiService } from "./ui";

const BASE_TITLE = "plugim";

const previewText = (content: string) => {
    if (content.startsWith("data:image/")) return "[图片]";
    if (content.startsWith("data:audio/")) return "[语音]";
    if (content.startsWith("data:video/")) return "[视频]";
    if (content.startsWith("data:")) return "[文件]";
    return content.replace(/\s+/g, " ");
};

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

let audioCtx: AudioContext | undefined;
const beep = () => {
    try {
        audioCtx ??= new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(
            0.001,
            audioCtx.currentTime + 0.18,
        );
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
    } catch {}
};

const dndKey = (owner: string) => `plugim_dnd:${owner}`;
const soundKey = (owner: string) => `plugim_sound:${owner}`;

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

const soundEnabled = (owner: string): boolean =>
    localStorage.getItem(soundKey(owner)) !== "0";

export const isSoundEnabled = soundEnabled;
export const setSoundEnabled = (owner: string, on: boolean) => {
    localStorage.setItem(soundKey(owner), on ? "1" : "0");
};

function NavIcon({
    to,
    icon,
    label,
}: {
    to: string;
    icon: ReactNode;
    label: string;
}) {
    return (
        <NavLink
            to={to}
            title={label}
            className={({ isActive }) =>
                cn(
                    "flex size-10 items-center justify-center rounded-lg",
                    isActive
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )
            }
        >
            {icon}
        </NavLink>
    );
}

export const uiSidebarPlugin: Plugin = {
    name: "ui-sidebar",
    description: "会话列表(群组 / 排序 / 置顶 / 免打扰 / 提醒)",
    inject: ["ui", "auth", "friends", "groups", "cache", "presence", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const friends = ctx.get<FriendsService>("friends");
        const groups = ctx.get<GroupsService>("groups");
        const cache = ctx.get<CacheService>("cache");
        const presence = ctx.get<PresenceService>("presence");
        const rpc = ctx.get<RpcService>("rpc");

        const Nav = () => {
            const user = useSyncExternalStore(
                (cb) => auth.onChange(cb),
                () => auth.user(),
            );
            return (
                <>
                    <NavIcon
                        to="/chat"
                        icon={<MessagesSquareIcon className="size-5" />}
                        label="聊天"
                    />
                    <NavIcon
                        to="/friends"
                        icon={<UsersIcon className="size-5" />}
                        label="好友"
                    />
                    <div className="mt-auto flex flex-col items-center gap-1">
                        {user ? (
                            <NavLink
                                to="/me"
                                title="用户中心"
                                className={({ isActive }) =>
                                    cn(
                                        "rounded-full",
                                        isActive && "ring-2 ring-primary",
                                    )
                                }
                            >
                                <UserAvatar name={user.username} size="sm" />
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
            const [active, setActive] = useState("general");
            const [unread, setUnread] = useState<Record<string, number>>({});
            const [previews, setPreviews] = useState<
                Record<string, SessionPreview>
            >({});
            const [pinned, setPinned] = useState<string[]>([]);
            const [dnd, setDnd] = useState<string[]>([]);
            const [mentioned, setMentioned] = useState<Record<string, boolean>>(
                {},
            );
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
            const nameInputRef = useRef<HTMLInputElement>(null);
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
                    if (me)
                        void cache.setUnread(me, next).catch(() => undefined);
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
                            void cache
                                .setPinned(me, next)
                                .catch(() => undefined);
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
                            localStorage.setItem(
                                dndKey(me),
                                JSON.stringify(next),
                            );
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
                    const message = (payload as { message: ChatMessage })
                        .message;
                    applyPreview(message);
                    if (message.sender === auth.user()?.username) return;
                    if (
                        message.mentions?.includes(auth.user()?.username ?? "")
                    ) {
                        setMentioned((prev) => ({
                            ...prev,
                            [message.session]: true,
                        }));
                    }
                    if (!dndRef.current.includes(message.session)) beep();
                    if (message.session === activeRef.current) return;
                    applyUnread({
                        ...unreadRef.current,
                        [message.session]:
                            (unreadRef.current[message.session] ?? 0) + 1,
                    });
                    notifyInBackground(message, dndRef.current);
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
                return () => {
                    void disposeOpen();
                    void disposeMsg();
                    void disposeRecall();
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

            useEffect(() => {
                if (!sessionMenu) return undefined;
                const close = () => setSessionMenu(null);
                const onKey = (e: KeyboardEvent) => {
                    if (e.key === "Escape") setSessionMenu(null);
                };
                window.addEventListener("click", close);
                window.addEventListener("keydown", onKey);
                window.addEventListener("wheel", close, { passive: true });
                return () => {
                    window.removeEventListener("click", close);
                    window.removeEventListener("keydown", onKey);
                    window.removeEventListener("wheel", close);
                };
            }, [sessionMenu]);

            useEffect(() => {
                if (!plusOpen && !createOpen) return undefined;
                const onDown = (e: MouseEvent) => {
                    const target = e.target as Node;
                    if (
                        plusOpen &&
                        !plusWrapRef.current?.contains(target) &&
                        !createCardRef.current?.contains(target)
                    )
                        setPlusOpen(false);
                    if (createOpen && !createCardRef.current?.contains(target))
                        setCreateOpen(false);
                };
                const onKey = (e: KeyboardEvent) => {
                    if (e.key === "Escape") {
                        setCreateOpen(false);
                        setPlusOpen(false);
                    }
                };
                window.addEventListener("mousedown", onDown);
                window.addEventListener("keydown", onKey);
                return () => {
                    window.removeEventListener("mousedown", onDown);
                    window.removeEventListener("keydown", onKey);
                };
            }, [plusOpen, createOpen]);

            useEffect(() => {
                if (createOpen) nameInputRef.current?.focus();
            }, [createOpen]);

            const openSession = (session: string, label: string) => {
                ctx.emit("ui:chat:open", { session, title: label });
                navigate("/chat");
            };

            const entries = [
                ...(groupList ?? []).map((group) => ({
                    session: `g:${group.id}`,
                    label: group.name,
                    isGroup: true,
                })),
                ...(list?.friends ?? []).map((name) => ({
                    session: `p2p:${name}`,
                    label: name,
                    isGroup: false,
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
                    alert(String(err instanceof Error ? err.message : err));
                } finally {
                    setCreating(false);
                }
            };

            const sessionItem = (entry: {
                session: string;
                label: string;
                isGroup: boolean;
            }) => {
                const { session, label, isGroup } = entry;
                const preview = previews[session];
                const count = unread[session] ?? 0;
                const peerName = session.startsWith("p2p:")
                    ? session.slice(4)
                    : null;
                const peerOnline =
                    peerName !== null && presence.isOnline(peerName);
                return (
                    <button
                        key={session}
                        type="button"
                        onClick={() => openSession(session, label)}
                        onContextMenu={(e) => {
                            e.preventDefault();
                            setSessionMenu({
                                x: e.clientX,
                                y: e.clientY,
                                session,
                                label,
                            });
                        }}
                        className={cn(
                            "flex w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                            active === session
                                ? "bg-chat-item-active"
                                : "hover:bg-muted/70",
                        )}
                    >
                        {isGroup ? (
                            <GroupAvatar name={label} />
                        ) : (
                            <span className="relative shrink-0">
                                <UserAvatar name={label} className="size-10" />
                                {peerOnline ? (
                                    <span className="absolute right-0 bottom-0 size-2.5 rounded-full bg-emerald-500 ring-2 ring-background" />
                                ) : null}
                            </span>
                        )}
                        <span className="min-w-0 flex-1">
                            <span className="flex items-baseline justify-between gap-2">
                                <span className="min-w-0 truncate text-sm font-medium">
                                    {pinned.includes(session) ? (
                                        <PinIconInline />
                                    ) : null}
                                    {label}
                                    {dnd.includes(session) ? (
                                        <BellOffIcon className="ml-1 inline size-3 text-muted-foreground" />
                                    ) : null}
                                </span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                    {preview ? previewTime(preview.at) : ""}
                                </span>
                            </span>
                            <span className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate text-xs text-muted-foreground">
                                    {mentioned[session] ? (
                                        <span className="mr-1 text-red-500">
                                            [@我]
                                        </span>
                                    ) : null}
                                    {preview
                                        ? previewText(preview.content)
                                        : "暂无消息"}
                                </span>
                                {count > 0 ? (
                                    <span
                                        className={cn(
                                            "flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] leading-none font-medium text-white",
                                            dnd.includes(session)
                                                ? "bg-gray-400"
                                                : "bg-red-500",
                                        )}
                                    >
                                        {count > 99 ? "99+" : count}
                                    </span>
                                ) : null}
                            </span>
                        </span>
                    </button>
                );
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
                        <input
                            readOnly
                            placeholder="搜索"
                            className="h-7 w-full rounded-md bg-muted px-2.5 text-xs outline-none placeholder:text-muted-foreground"
                        />
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
                        {entries.map(sessionItem)}
                        {entries.length === 0 ? (
                            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                                还没有会话，去好友页添加好友或右上角新建群聊
                            </p>
                        ) : null}
                    </div>
                    {sessionMenu ? (
                        <div
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
                                                                ? [
                                                                      ...prev,
                                                                      name,
                                                                  ]
                                                                : prev.filter(
                                                                      (x) =>
                                                                          x !==
                                                                          name,
                                                                  ),
                                                        )
                                                    }
                                                />
                                                <UserAvatar
                                                    name={name}
                                                    size="sm"
                                                />
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
                                            groupName.trim().length < 2 ||
                                            creating
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
    },
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

const notifyInBackground = (message: ChatMessage, dnd: string[]) => {
    if (document.visibilityState !== "hidden") return;
    if (dnd.includes(message.session)) return;
    if (
        typeof Notification === "undefined" ||
        Notification.permission !== "granted"
    )
        return;
    try {
        new Notification(message.sender, {
            body: previewText(message.content).slice(0, 80),
            tag: message.session,
        });
    } catch {}
};
