import type { Context } from "@plugim/core";
import type { ChatMessage, GroupInfo, MergePayload } from "@plugim/protocol";
import {
    AlertCircleIcon,
    ArrowDownIcon,
    CheckIcon,
    ClockIcon,
    CopyIcon,
    CornerUpLeftIcon,
    FileIcon,
    ForwardIcon,
    ListChecksIcon,
    MegaphoneIcon,
    RotateCcwIcon,
    XIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useReducer, useRef, useState } from "react";
import { Bubble, BubbleContent } from "../components/ui/bubble";
import {
    Message,
    MessageAvatar,
    MessageContent,
    MessageGroup,
    MessageHeader,
} from "../components/ui/message";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { CacheService } from "./cache";
import type { ConnStatus, RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { GroupsService } from "./groups";
import type { PendingEvent, PendingMessage, SenderService } from "./sender";
import { formatBytes, messageLabel } from "./ui-shared";
import type { UiService } from "./ui-types";

const PAGE_SIZE = 30;
const RECALL_WINDOW_MS = 2 * 60 * 1000;
const STAMP_GAP_MS = 5 * 60 * 1000;
const AT_BOTTOM_PX = 80;

const pad = (n: number) => String(n).padStart(2, "0");

function formatStamp(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const startOf = (x: Date) =>
        new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
    if (diffDays === 0) return time;
    if (diffDays === 1) return `昨天 ${time}`;
    if (diffDays < 7) return `星期${"日一二三四五六"[d.getDay()]} ${time}`;
    if (d.getFullYear() === now.getFullYear())
        return `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
}

const isImage = (message: ChatMessage) =>
    message.kind === "image" || message.content.startsWith("data:image/");

const parseMerge = (message: ChatMessage): MergePayload | null => {
    if (message.kind !== "merge") return null;
    try {
        const parsed = JSON.parse(message.content) as MergePayload;
        return parsed?.merge === 1 && Array.isArray(parsed.list)
            ? parsed
            : null;
    } catch {
        return null;
    }
};

const mediaKind = (message: ChatMessage) =>
    message.kind ??
    (message.content.startsWith("data:")
        ? message.content.startsWith("data:audio/")
            ? "audio"
            : message.content.startsWith("data:video/")
              ? "video"
              : isImage(message)
                ? "image"
                : "file"
        : "text");

function contentPreview(message: ChatMessage): string {
    if (message.recalledAt) return "[消息已撤回]";
    return (
        messageLabel(message.kind, message.content, message.file?.name) ??
        message.content.replace(/\s+/g, " ")
    );
}

const escapeRegExp = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function mergeById(...lists: ChatMessage[][]): ChatMessage[] {
    const byId = new Map<string, ChatMessage>();
    for (const list of lists) {
        for (const message of list) byId.set(message.id, message);
    }
    return [...byId.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
    );
}

interface Group {
    sender: string;
    mine: boolean;
    items: ChatMessage[];
}

type Row =
    | { kind: "stamp"; key: string; label: string }
    | { kind: "group"; key: string; group: Group };

function toRows(messages: ChatMessage[], me: string): Row[] {
    const rows: Row[] = [];
    let current: Group | null = null;
    let lastTs = 0;
    for (const message of messages) {
        const ts = Date.parse(message.createdAt);
        if (
            !current ||
            current.sender !== message.sender ||
            ts - lastTs >= STAMP_GAP_MS
        ) {
            if (ts - lastTs >= STAMP_GAP_MS) {
                rows.push({
                    kind: "stamp",
                    key: `s-${message.id}`,
                    label: formatStamp(message.createdAt),
                });
            }
            current = {
                sender: message.sender,
                mine: message.sender === me,
                items: [],
            };
            rows.push({
                kind: "group",
                key: `g-${message.id}`,
                group: current,
            });
        }
        current.items.push(message);
        lastTs = ts;
    }
    return rows;
}

export const uiMessagesSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const rpc = ctx.get<RpcService>("rpc");
    const cache = ctx.get<CacheService>("cache");
    const sender = ctx.get<SenderService>("sender");
    const friends = ctx.get<FriendsService>("friends");
    const groups = ctx.get<GroupsService>("groups");

    const Messages = () => {
        const [session, setSession] = useState("");
        const [messages, setMessages] = useState<ChatMessage[]>([]);
        const [status, setStatus] = useState<ConnStatus>(rpc.status());
        const [loadingOlder, setLoadingOlder] = useState(false);
        const [hasMore, setHasMore] = useState(true);
        const [menu, setMenu] = useState<{
            x: number;
            y: number;
            message: ChatMessage;
        } | null>(null);
        const [pending, setPending] = useState<PendingMessage[]>([]);
        const [atBottom, setAtBottom] = useState(true);
        const [newCount, setNewCount] = useState(0);
        const [searchQuery, setSearchQuery] = useState<string | null>(null);
        const [searchResults, setSearchResults] = useState<ChatMessage[]>([]);
        const [highlightId, setHighlightId] = useState<string | null>(null);
        const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
        const [peerReadAt, setPeerReadAt] = useState<string | null>(null);
        const [forwardIds, setForwardIds] = useState<string[]>([]);
        const [forwardPreview, setForwardPreview] = useState("");
        const [forwardSel, setForwardSel] = useState<Set<string>>(new Set());
        const [forwardBusy, setForwardBusy] = useState(false);
        const [forwardError, setForwardError] = useState<string | null>(null);
        const [selectMode, setSelectMode] = useState(false);
        const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
        const [mergeView, setMergeView] = useState<MergePayload | null>(null);
        const [, bumpForward] = useReducer((n: number) => n + 1, 0);
        useEffect(() => {
            if (forwardIds.length === 0) return undefined;
            const offA = friends.onUpdate(bumpForward);
            const offB = groups.onUpdate(bumpForward);
            return () => {
                offA();
                offB();
            };
        }, [forwardIds.length]);
        const bottomRef = useRef<HTMLDivElement>(null);
        const scrollRef = useRef<HTMLDivElement>(null);
        const sessionRef = useRef(session);
        const loadingRef = useRef(false);
        const skipScrollRef = useRef(false);
        const prevCountRef = useRef(0);
        const lastScrollTopRef = useRef(0);
        const atBottomRef = useRef(true);
        const user = auth.user();
        const me = user?.username ?? "";
        const isP2p = session.startsWith("p2p:");

        useEffect(() => rpc.onStatus(setStatus), []);

        useEffect(() => {
            const dispose = ctx.on("ui:chat:open", (payload) => {
                setSession((payload as { session: string }).session);
                setSelectMode(false);
                setSelectedIds(new Set());
            });
            return () => {
                void dispose();
            };
        }, []);

        useEffect(() => {
            const dispose = ctx.on("chat:pending", (payload) => {
                const { type, pending: item } = payload as PendingEvent;
                setPending((prev) => {
                    const rest = prev.filter((x) => x.tempId !== item.tempId);
                    if (type === "remove") return rest;
                    return [...rest, item];
                });
            });
            return () => {
                void dispose();
            };
        }, []);

        useEffect(() => {
            const dispose = ctx.on("ui:chat:search", (payload) => {
                const query = (payload as { query: string }).query;
                if (!query.trim()) {
                    setSearchQuery(null);
                    setSearchResults([]);
                    return;
                }
                setSearchQuery(query);
                void cache
                    .searchMessages(me, sessionRef.current, query)
                    .then(setSearchResults)
                    .catch(() => setSearchResults([]));
            });
            return () => {
                void dispose();
            };
        }, [me]);

        useEffect(() => {
            void session;
            setSearchQuery(null);
            setSearchResults([]);
        }, [session]);

        useEffect(() => {
            void status;
            if (!session.startsWith("g:")) {
                setGroupInfo(null);
                return;
            }
            const load = () => {
                void rpc
                    .call("group.info", { groupId: session.slice(2) })
                    .then((result) => setGroupInfo(result as GroupInfo))
                    .catch(() => setGroupInfo(null));
            };
            load();
            const dispose = ctx.on("server:group:update", load);
            return () => {
                void dispose();
            };
        }, [session, status]);

        useEffect(() => {
            if (!me || !session || status !== "open") return undefined;
            if (session.startsWith("p2p:")) {
                void rpc
                    .call("receipt.list", { session })
                    .then((rows) => {
                        const peer = session.slice(4);
                        const row = (
                            rows as {
                                username: string;
                                at: string;
                            }[]
                        ).find((item) => item.username === peer);
                        setPeerReadAt(row?.at ?? null);
                    })
                    .catch(() => undefined);
            }
            void rpc.call("receipt.read", { session }).catch(() => undefined);
            const dispose = ctx.on("server:receipt:update", (payload) => {
                const data = payload as {
                    session: string;
                    username: string;
                    at: string;
                };
                if (
                    session.startsWith("p2p:") &&
                    data.session === session &&
                    data.username === session.slice(4)
                )
                    setPeerReadAt(data.at);
            });
            return () => {
                void dispose();
            };
        }, [session, status, me]);

        useEffect(() => {
            sessionRef.current = session;
            let alive = true;
            setHasMore(true);
            prevCountRef.current = 0;
            setMessages([]);
            setNewCount(0);

            if (!me || !session) return undefined;

            void cache
                .getMessages(me, session)
                .then((cached) => {
                    if (!alive || sessionRef.current !== session) return;
                    if (cached.length > 0) setMessages(cached);
                })
                .catch(() => undefined);

            const loadFresh = () => {
                void rpc
                    .call("history.list", { session, limit: PAGE_SIZE })
                    .then((result) => {
                        if (!alive || sessionRef.current !== session) return;
                        const fresh = result as ChatMessage[];
                        setMessages((prev) => mergeById(prev, fresh));
                        void cache
                            .putMessages(me, session, fresh)
                            .catch(() => undefined);
                    })
                    .catch(() => undefined);
            };

            if (status === "open") {
                loadFresh();
                return () => {
                    alive = false;
                };
            }
            const dispose = rpc.onStatus((next) => {
                if (next === "open") loadFresh();
            });
            return () => {
                alive = false;
                dispose();
            };
        }, [session, status, me]);

        useEffect(() => {
            const dispose = ctx.on("server:message:new", (payload) => {
                const message = (payload as { message: ChatMessage }).message;
                if (message.session !== sessionRef.current) return;
                setMessages((prev) => mergeById(prev, [message]));
                void cache
                    .putMessages(me, message.session, [message])
                    .catch(() => undefined);
                void rpc
                    .call("receipt.read", { session: message.session })
                    .catch(() => undefined);
            });
            return () => {
                void dispose();
            };
        }, [me]);

        useEffect(() => {
            const dispose = ctx.on("server:message:recalled", (payload) => {
                const {
                    id,
                    session: evtSession,
                    recalledAt,
                } = payload as {
                    id: string;
                    session: string;
                    recalledAt: string;
                };
                setMessages((prev) =>
                    prev.map((message) =>
                        message.id === id
                            ? { ...message, recalledAt }
                            : message,
                    ),
                );
                void cache
                    .recallMessage(me, evtSession, id, recalledAt)
                    .catch(() => undefined);
            });
            return () => {
                void dispose();
            };
        }, [me]);

        useEffect(() => {
            if (!menu) return undefined;
            const close = () => setMenu(null);
            const onKey = (e: KeyboardEvent) => {
                if (e.key === "Escape") setMenu(null);
            };
            window.addEventListener("click", close);
            window.addEventListener("keydown", onKey);
            window.addEventListener("wheel", close, { passive: true });
            return () => {
                window.removeEventListener("click", close);
                window.removeEventListener("keydown", onKey);
                window.removeEventListener("wheel", close);
            };
        }, [menu]);

        const sessionPending = pending.filter(
            (item) => item.session === session,
        );
        const totalCount = messages.length + sessionPending.length;

        useEffect(() => {
            if (skipScrollRef.current) {
                skipScrollRef.current = false;
                prevCountRef.current = totalCount;
                return;
            }
            const delta = totalCount - prevCountRef.current;
            prevCountRef.current = totalCount;
            if (delta <= 0) return;
            const last =
                messages[messages.length - 1] ??
                sessionPending[sessionPending.length - 1];
            const mineLast = last?.sender === me;
            if (atBottomRef.current || mineLast) {
                setTimeout(() => {
                    bottomRef.current?.scrollIntoView({
                        behavior: "smooth",
                    });
                }, 0);
            } else {
                setNewCount((prev) => prev + delta);
            }
        }, [totalCount, messages, sessionPending, me]);

        const loadOlder = async () => {
            if (loadingRef.current || !hasMore || !me) return;
            const oldest = messages[0];
            if (!oldest) return;
            loadingRef.current = true;
            setLoadingOlder(true);
            const el = scrollRef.current;
            const prevHeight = el?.scrollHeight ?? 0;
            try {
                const older = (await rpc.call("history.list", {
                    session,
                    limit: PAGE_SIZE,
                    before: oldest.createdAt,
                })) as ChatMessage[];
                setHasMore(older.length >= PAGE_SIZE);
                if (older.length > 0) {
                    skipScrollRef.current = true;
                    setMessages((prev) => mergeById(prev, older));
                    void cache
                        .putMessages(me, session, older)
                        .catch(() => undefined);
                }
                requestAnimationFrame(() => {
                    if (el) el.scrollTop = el.scrollHeight - prevHeight;
                });
            } catch {
                setHasMore(false);
            } finally {
                setLoadingOlder(false);
                loadingRef.current = false;
            }
        };

        const handleScroll = () => {
            const el = scrollRef.current;
            if (!el) return;
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            const nearBottom = distance < AT_BOTTOM_PX;
            if (nearBottom !== atBottomRef.current) {
                atBottomRef.current = nearBottom;
                setAtBottom(nearBottom);
                if (nearBottom) setNewCount(0);
            }
            const goingUp = lastScrollTopRef.current - el.scrollTop > 0;
            lastScrollTopRef.current = el.scrollTop;
            if (
                goingUp &&
                el.scrollTop < 60 &&
                !loadingRef.current &&
                hasMore
            ) {
                void loadOlder();
            }
        };

        const scrollToBottom = () => {
            atBottomRef.current = true;
            setAtBottom(true);
            setNewCount(0);
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        };

        const jumpToMessage = (id: string) => {
            setSearchQuery(null);
            setSearchResults([]);
            let attempts = 0;
            const tryJump = () => {
                attempts += 1;
                const el = document.getElementById(`msg-${id}`);
                if (!el) {
                    if (attempts < 20) setTimeout(tryJump, 50);
                    return;
                }
                atBottomRef.current = false;
                setAtBottom(false);
                el.scrollIntoView({ block: "center", behavior: "smooth" });
                setHighlightId(id);
                setTimeout(() => setHighlightId(null), 2000);
            };
            setTimeout(tryJump, 50);
        };

        const recall = async (message: ChatMessage) => {
            try {
                await rpc.call("message.recall", { id: message.id });
            } catch {}
        };

        const copy = async (message: ChatMessage) => {
            try {
                await navigator.clipboard.writeText(message.content);
            } catch {}
        };

        const reply = (message: ChatMessage) => {
            ctx.emit("ui:chat:quote", {
                sender: message.sender,
                content: contentPreview(message),
            });
        };

        const openMedia = (message: ChatMessage) => {
            ctx.emit("ui:media:preview", { message });
        };

        const openProfile = (username: string, e: ReactMouseEvent) => {
            ctx.emit("ui:profile:open", {
                username,
                x: e.clientX,
                y: e.clientY,
            });
        };

        const canRecall = (message: ChatMessage) =>
            message.sender === me &&
            !message.recalledAt &&
            Date.now() - Date.parse(message.createdAt) <= RECALL_WINDOW_MS;

        const openForward = (ids: string[], preview: string) => {
            setForwardIds(ids);
            setForwardPreview(preview);
            setForwardSel(new Set());
            setForwardError(null);
            void friends.refresh().catch(() => {});
            void groups.refresh().catch(() => {});
        };

        const exitSelect = () => {
            setSelectMode(false);
            setSelectedIds(new Set());
        };

        const toggleSelect = (message: ChatMessage) => {
            if (message.recalledAt) return;
            setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(message.id)) next.delete(message.id);
                else next.add(message.id);
                return next;
            });
        };

        const submitForward = async () => {
            if (forwardIds.length === 0 || forwardSel.size === 0 || forwardBusy)
                return;
            setForwardBusy(true);
            setForwardError(null);
            try {
                await rpc.call("message.forward", {
                    ids: forwardIds,
                    sessions: [...forwardSel],
                });
                setForwardIds([]);
                exitSelect();
            } catch (err) {
                setForwardError(
                    err instanceof Error ? err.message : String(err),
                );
            } finally {
                setForwardBusy(false);
            }
        };

        const forwardTargets = [
            ...(friends.cached()?.friends ?? []).map((username) => ({
                key: `p2p:${username}`,
                label: username,
                group: "好友" as const,
            })),
            ...(groups.cached() ?? []).map((group) => ({
                key: `g:${group.id}`,
                label: group.name,
                group: "群组" as const,
            })),
        ];

        const renderText = (message: ChatMessage, mine: boolean) => {
            const mentions = message.mentions;
            if (!mentions || mentions.length === 0) return message.content;
            const re = new RegExp(
                `@(?:${mentions.map(escapeRegExp).join("|")})`,
                "g",
            );
            const nodes: ReactNode[] = [];
            let lastIndex = 0;
            let seq = 0;
            for (const match of message.content.matchAll(re)) {
                if (match.index > lastIndex)
                    nodes.push(message.content.slice(lastIndex, match.index));
                nodes.push(
                    <span
                        key={`mention-${seq++}`}
                        className={
                            mine
                                ? "font-medium text-white"
                                : "font-medium text-primary"
                        }
                    >
                        {match[0]}
                    </span>,
                );
                lastIndex = match.index + match[0].length;
            }
            nodes.push(message.content.slice(lastIndex));
            return nodes;
        };

        const rows = toRows(messages, me);
        const lastOwnId = [...messages]
            .reverse()
            .find(
                (message) => message.sender === me && !message.recalledAt,
            )?.id;

        const menuItem = (
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
                    setMenu(null);
                    onClick();
                }}
            >
                {icon}
                {label}
            </button>
        );

        if (searchQuery !== null) {
            return (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2 text-xs text-muted-foreground">
                        <span>
                            “{searchQuery}” 的搜索结果 {searchResults.length} 条
                        </span>
                        <button
                            type="button"
                            className="ml-auto flex items-center gap-1 rounded-md px-2 py-1 hover:bg-accent"
                            onClick={() => {
                                setSearchQuery(null);
                                ctx.emit("ui:chat:search:clear", {});
                            }}
                        >
                            <XIcon className="size-3.5" />
                            退出搜索
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto p-2">
                        {searchResults.length === 0 ? (
                            <p className="py-8 text-center text-xs text-muted-foreground">
                                本地缓存中没有匹配的消息
                            </p>
                        ) : (
                            searchResults.map((message) => (
                                <button
                                    key={message.id}
                                    type="button"
                                    className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left hover:bg-accent/60"
                                    onClick={() => jumpToMessage(message.id)}
                                >
                                    <span className="text-xs text-muted-foreground">
                                        {message.sender}{" "}
                                        {formatStamp(message.createdAt)}
                                    </span>
                                    <span className="truncate text-sm">
                                        {contentPreview(message)}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            );
        }

        if (!session) {
            return (
                <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground/70">
                    从左侧选择一个会话开始聊天
                </div>
            );
        }

        return (
            <>
                <div className="relative flex min-h-0 flex-1 flex-col">
                    <div
                        ref={scrollRef}
                        onScroll={handleScroll}
                        className="flex min-h-0 flex-1 flex-col gap-1 overflow-x-clip overflow-y-auto px-4 py-3"
                    >
                        {groupInfo?.notice ? (
                            <button
                                type="button"
                                className="mb-1 flex max-w-full items-center gap-1.5 self-center rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800 hover:bg-amber-200 dark:bg-amber-500/15 dark:text-amber-300"
                                onClick={() =>
                                    ctx.emit("ui:group:manage", {
                                        groupId: groupInfo.id,
                                    })
                                }
                            >
                                <MegaphoneIcon className="size-3.5 shrink-0" />
                                <span className="truncate">
                                    {groupInfo.notice}
                                </span>
                            </button>
                        ) : null}
                        {loadingOlder ? (
                            <p className="py-1 text-center text-xs text-muted-foreground">
                                正在加载更早的消息...
                            </p>
                        ) : null}
                        {rows.map((row) =>
                            row.kind === "stamp" ? (
                                <p
                                    key={row.key}
                                    className="py-2 text-center text-xs text-muted-foreground/80"
                                >
                                    {row.label}
                                </p>
                            ) : (
                                <MessageGroup key={row.key}>
                                    {row.group.items.map((message) => {
                                        const mine = row.group.mine;
                                        if (message.recalledAt) {
                                            return (
                                                <p
                                                    key={message.id}
                                                    className="py-0.5 text-center text-xs text-muted-foreground/80"
                                                >
                                                    「{message.sender}
                                                    」撤回了一条消息
                                                </p>
                                            );
                                        }
                                        const media = mediaKind(message);
                                        const bare =
                                            media === "image" ||
                                            media === "video" ||
                                            media === "merge";
                                        return (
                                            <Message
                                                key={message.id}
                                                id={`msg-${message.id}`}
                                                align={mine ? "end" : "start"}
                                                className={cn(
                                                    "py-0.5 transition-colors",
                                                    highlightId ===
                                                        message.id &&
                                                        "rounded-xl bg-primary/10",
                                                    selectMode &&
                                                        !message.recalledAt &&
                                                        "cursor-pointer",
                                                    selectMode &&
                                                        selectedIds.has(
                                                            message.id,
                                                        ) &&
                                                        "rounded-xl bg-primary/10",
                                                )}
                                                onClick={
                                                    selectMode
                                                        ? () =>
                                                              toggleSelect(
                                                                  message,
                                                              )
                                                        : undefined
                                                }
                                            >
                                                <MessageAvatar>
                                                    {selectMode ? (
                                                        <span
                                                            className={cn(
                                                                "flex size-7 items-center justify-center self-center rounded-full border-2 transition-colors",
                                                                selectedIds.has(
                                                                    message.id,
                                                                )
                                                                    ? "border-primary bg-primary text-primary-foreground"
                                                                    : "border-border bg-card",
                                                            )}
                                                        >
                                                            {selectedIds.has(
                                                                message.id,
                                                            ) ? (
                                                                <CheckIcon className="size-4" />
                                                            ) : null}
                                                        </span>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            title="查看资料"
                                                            className="rounded-full"
                                                            onClick={(e) =>
                                                                openProfile(
                                                                    message.sender,
                                                                    e,
                                                                )
                                                            }
                                                        >
                                                            <UserAvatar
                                                                name={
                                                                    message.sender
                                                                }
                                                            />
                                                        </button>
                                                    )}
                                                </MessageAvatar>
                                                <MessageContent>
                                                    {!mine && !isP2p ? (
                                                        <MessageHeader>
                                                            {message.sender}
                                                        </MessageHeader>
                                                    ) : null}
                                                    <Bubble
                                                        variant={
                                                            bare
                                                                ? "ghost"
                                                                : mine
                                                                  ? "default"
                                                                  : "outline"
                                                        }
                                                        align={
                                                            mine
                                                                ? "end"
                                                                : "start"
                                                        }
                                                        onContextMenu={(e) => {
                                                            e.preventDefault();
                                                            setMenu({
                                                                x: e.clientX,
                                                                y: e.clientY,
                                                                message,
                                                            });
                                                        }}
                                                    >
                                                        <BubbleContent
                                                            className={
                                                                bare
                                                                    ? "p-0.5"
                                                                    : mine
                                                                      ? "rounded-xl rounded-br-sm"
                                                                      : "rounded-xl rounded-bl-sm"
                                                            }
                                                        >
                                                            {media ===
                                                            "merge" ? (
                                                                (() => {
                                                                    const payload =
                                                                        parseMerge(
                                                                            message,
                                                                        );
                                                                    if (
                                                                        !payload
                                                                    )
                                                                        return (
                                                                            <p className="whitespace-pre-wrap">
                                                                                {contentPreview(
                                                                                    message,
                                                                                )}
                                                                            </p>
                                                                        );
                                                                    return (
                                                                        <button
                                                                            type="button"
                                                                            title="点击查看合并的转发消息"
                                                                            className="flex w-56 flex-col gap-1 rounded-lg bg-card px-3 py-2.5 text-left text-foreground transition-colors hover:bg-accent/60"
                                                                            onClick={() =>
                                                                                setMergeView(
                                                                                    payload,
                                                                                )
                                                                            }
                                                                        >
                                                                            <p className="truncate text-sm font-medium">
                                                                                {
                                                                                    payload.title
                                                                                }
                                                                            </p>
                                                                            <p className="truncate text-xs text-muted-foreground">
                                                                                {payload.list
                                                                                    .slice(
                                                                                        0,
                                                                                        2,
                                                                                    )
                                                                                    .map(
                                                                                        (
                                                                                            item,
                                                                                        ) =>
                                                                                            `${item.sender}: ${messageLabel(item.kind, item.content) ?? item.content}`,
                                                                                    )
                                                                                    .join(
                                                                                        " \n",
                                                                                    )}
                                                                            </p>
                                                                            <p className="text-[10px] text-muted-foreground/80">
                                                                                点击查看
                                                                            </p>
                                                                        </button>
                                                                    );
                                                                })()
                                                            ) : media ===
                                                              "image" ? (
                                                                <button
                                                                    type="button"
                                                                    title="点击查看大图"
                                                                    className="cursor-zoom-in"
                                                                    onClick={() =>
                                                                        openMedia(
                                                                            message,
                                                                        )
                                                                    }
                                                                >
                                                                    <img
                                                                        src={
                                                                            message.content
                                                                        }
                                                                        alt="图片"
                                                                        loading="lazy"
                                                                        className="max-h-80 w-auto max-w-full rounded-lg"
                                                                    />
                                                                </button>
                                                            ) : media ===
                                                              "video" ? (
                                                                <button
                                                                    type="button"
                                                                    title="点击播放视频"
                                                                    className="relative cursor-pointer"
                                                                    onClick={() =>
                                                                        openMedia(
                                                                            message,
                                                                        )
                                                                    }
                                                                >
                                                                    <video
                                                                        src={
                                                                            message.content
                                                                        }
                                                                        preload="metadata"
                                                                        className="max-h-64 w-auto max-w-80 rounded-lg bg-black"
                                                                    >
                                                                        <track
                                                                            kind="captions"
                                                                            src=""
                                                                            label="字幕"
                                                                        />
                                                                    </video>
                                                                </button>
                                                            ) : media ===
                                                              "audio" ? (
                                                                <div className="flex min-w-52 items-center gap-2">
                                                                    <audio
                                                                        src={
                                                                            message.content
                                                                        }
                                                                        controls
                                                                        className="h-8 w-full min-w-44"
                                                                    >
                                                                        <track
                                                                            kind="captions"
                                                                            src=""
                                                                            label="字幕"
                                                                        />
                                                                    </audio>
                                                                </div>
                                                            ) : media ===
                                                              "file" ? (
                                                                <button
                                                                    type="button"
                                                                    onClick={() =>
                                                                        openMedia(
                                                                            message,
                                                                        )
                                                                    }
                                                                    className={cn(
                                                                        "flex w-60 items-center gap-2.5 rounded-lg p-2 text-left",
                                                                        mine
                                                                            ? "bg-white/15"
                                                                            : "bg-black/5 dark:bg-white/10",
                                                                    )}
                                                                >
                                                                    <FileIcon
                                                                        className={cn(
                                                                            "size-8 shrink-0",
                                                                            mine
                                                                                ? "text-white"
                                                                                : "text-primary",
                                                                        )}
                                                                    />
                                                                    <span className="min-w-0 flex-1">
                                                                        <span className="block truncate text-sm">
                                                                            {message
                                                                                .file
                                                                                ?.name ??
                                                                                "文件"}
                                                                        </span>
                                                                        <span
                                                                            className={cn(
                                                                                "text-xs",
                                                                                mine
                                                                                    ? "text-white/70"
                                                                                    : "text-muted-foreground",
                                                                            )}
                                                                        >
                                                                            {formatBytes(
                                                                                message
                                                                                    .file
                                                                                    ?.size ??
                                                                                    0,
                                                                            )}
                                                                        </span>
                                                                    </span>
                                                                </button>
                                                            ) : (
                                                                <p className="whitespace-pre-wrap">
                                                                    {renderText(
                                                                        message,
                                                                        mine,
                                                                    )}
                                                                </p>
                                                            )}
                                                            {message.quote ? (
                                                                <div
                                                                    className={
                                                                        mine
                                                                            ? "mt-1 max-w-full truncate rounded-md bg-white/20 px-2 py-1 text-xs text-white/90"
                                                                            : "mt-1 max-w-full truncate rounded-md bg-black/5 px-2 py-1 text-xs text-muted-foreground dark:bg-white/10"
                                                                    }
                                                                >
                                                                    {
                                                                        message
                                                                            .quote
                                                                            .sender
                                                                    }
                                                                    :{" "}
                                                                    {
                                                                        message
                                                                            .quote
                                                                            .content
                                                                    }
                                                                </div>
                                                            ) : null}
                                                        </BubbleContent>
                                                    </Bubble>
                                                    {isP2p &&
                                                    mine &&
                                                    message.id === lastOwnId ? (
                                                        <p className="self-end px-1 text-[10px] text-muted-foreground">
                                                            {peerReadAt &&
                                                            message.createdAt <=
                                                                peerReadAt
                                                                ? "已读"
                                                                : "未读"}
                                                        </p>
                                                    ) : null}
                                                </MessageContent>
                                            </Message>
                                        );
                                    })}
                                </MessageGroup>
                            ),
                        )}
                        {sessionPending.map((item) => (
                            <Message
                                key={item.tempId}
                                align="end"
                                className="py-0.5"
                            >
                                <MessageAvatar>
                                    <UserAvatar name={item.sender || "?"} />
                                </MessageAvatar>
                                <MessageContent>
                                    <div className="flex items-center gap-1.5 self-end">
                                        {item.state === "failed" ? (
                                            <button
                                                type="button"
                                                title={
                                                    item.error ??
                                                    "发送失败，点击重发"
                                                }
                                                className="text-destructive"
                                                onClick={() =>
                                                    void sender.retry(
                                                        item.tempId,
                                                    )
                                                }
                                            >
                                                <AlertCircleIcon className="size-4.5" />
                                            </button>
                                        ) : (
                                            <ClockIcon className="size-3.5 text-muted-foreground" />
                                        )}
                                        <Bubble
                                            variant="default"
                                            align="end"
                                            className={
                                                item.state === "failed"
                                                    ? "opacity-60"
                                                    : "opacity-70"
                                            }
                                        >
                                            <BubbleContent className="rounded-xl rounded-br-sm">
                                                <p className="whitespace-pre-wrap">
                                                    {messageLabel(
                                                        item.kind,
                                                        item.content,
                                                        item.file?.name,
                                                    ) ?? item.content}
                                                </p>
                                            </BubbleContent>
                                        </Bubble>
                                    </div>
                                </MessageContent>
                            </Message>
                        ))}
                        <div ref={bottomRef} />
                    </div>

                    {!atBottom ? (
                        <button
                            type="button"
                            onClick={scrollToBottom}
                            className="absolute bottom-4 right-4 z-10 flex h-8 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs shadow-md hover:bg-accent"
                        >
                            {newCount > 0 ? (
                                <span className="font-medium text-primary">
                                    {newCount > 99 ? "99+" : newCount} 条新消息
                                </span>
                            ) : null}
                            <ArrowDownIcon className="size-4" />
                        </button>
                    ) : null}
                    {selectMode ? (
                        <div className="absolute bottom-3 left-1/2 z-10 flex h-10 -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background px-4 text-xs shadow-md">
                            <span className="font-medium">
                                已选 {selectedIds.size} 条
                            </span>
                            <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={exitSelect}
                            >
                                取消
                            </button>
                            <button
                                type="button"
                                disabled={selectedIds.size === 0}
                                className="flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                onClick={() =>
                                    openForward(
                                        [...selectedIds],
                                        `${selectedIds.size} 条消息`,
                                    )
                                }
                            >
                                <ForwardIcon className="size-3.5" />
                                转发
                            </button>
                        </div>
                    ) : null}
                </div>

                {menu ? (
                    <div
                        role="menu"
                        className="fixed z-50 w-36 rounded-lg border border-border bg-popover py-1 text-sm shadow-lg"
                        style={{
                            left: Math.min(menu.x, window.innerWidth - 160),
                            top: Math.min(menu.y, window.innerHeight - 160),
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                    >
                        {menuItem(
                            "quote",
                            <CornerUpLeftIcon className="size-4" />,
                            "回复",
                            () => reply(menu.message),
                        )}
                        {!menu.message.recalledAt
                            ? menuItem(
                                  "forward",
                                  <ForwardIcon className="size-4" />,
                                  "转发",
                                  () =>
                                      openForward(
                                          [menu.message.id],
                                          contentPreview(menu.message),
                                      ),
                              )
                            : null}
                        {!menu.message.recalledAt
                            ? menuItem(
                                  "select",
                                  <ListChecksIcon className="size-4" />,
                                  "多选",
                                  () => {
                                      setSelectMode(true);
                                      setSelectedIds(
                                          new Set([menu.message.id]),
                                      );
                                  },
                              )
                            : null}
                        {isImage(menu.message)
                            ? null
                            : menuItem(
                                  "copy",
                                  <CopyIcon className="size-4" />,
                                  "复制",
                                  () => void copy(menu.message),
                              )}
                        {canRecall(menu.message)
                            ? menuItem(
                                  "recall",
                                  <RotateCcwIcon className="size-4" />,
                                  "撤回",
                                  () => void recall(menu.message),
                              )
                            : null}
                    </div>
                ) : null}

                {forwardIds.length > 0 ? (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                        role="dialog"
                        aria-modal="true"
                        aria-label="转发消息"
                        onKeyDown={(e) => {
                            if (e.key === "Escape") setForwardIds([]);
                        }}
                        onClick={(e) => {
                            if (e.target === e.currentTarget) setForwardIds([]);
                        }}
                    >
                        <div className="flex max-h-[70vh] w-full max-w-sm flex-col rounded-xl border border-border bg-card shadow-xl">
                            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                                <p className="flex-1 text-sm font-semibold">
                                    转发 {forwardIds.length} 条消息
                                </p>
                                <button
                                    type="button"
                                    aria-label="关闭"
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                                    onClick={() => setForwardIds([])}
                                >
                                    <XIcon className="size-4" />
                                </button>
                            </div>
                            <div className="truncate border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
                                {forwardIds.length > 1
                                    ? `${forwardIds.length} 条消息`
                                    : forwardPreview}
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto py-1">
                                {forwardTargets.length === 0 ? (
                                    <p className="py-8 text-center text-xs text-muted-foreground">
                                        暂无可转发的会话
                                    </p>
                                ) : null}
                                {(["好友", "群组"] as const).map((label) => {
                                    const items = forwardTargets.filter(
                                        (t) => t.group === label,
                                    );
                                    if (items.length === 0) return null;
                                    return (
                                        <div key={label}>
                                            <p className="px-4 pt-2 pb-1 text-xs font-semibold text-muted-foreground">
                                                {label}
                                            </p>
                                            {items.map((target) => (
                                                <button
                                                    key={target.key}
                                                    type="button"
                                                    className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent/60"
                                                    onClick={() =>
                                                        setForwardSel(
                                                            (prev) => {
                                                                const next =
                                                                    new Set(
                                                                        prev,
                                                                    );
                                                                if (
                                                                    next.has(
                                                                        target.key,
                                                                    )
                                                                )
                                                                    next.delete(
                                                                        target.key,
                                                                    );
                                                                else
                                                                    next.add(
                                                                        target.key,
                                                                    );
                                                                return next;
                                                            },
                                                        )
                                                    }
                                                >
                                                    <span
                                                        className={cn(
                                                            "flex size-4 items-center justify-center rounded border",
                                                            forwardSel.has(
                                                                target.key,
                                                            )
                                                                ? "border-primary bg-primary text-primary-foreground"
                                                                : "border-border",
                                                        )}
                                                    >
                                                        {forwardSel.has(
                                                            target.key,
                                                        ) ? (
                                                            <CheckIcon className="size-3" />
                                                        ) : null}
                                                    </span>
                                                    <span className="truncate">
                                                        {target.label}
                                                    </span>
                                                </button>
                                            ))}
                                        </div>
                                    );
                                })}
                            </div>
                            {forwardError ? (
                                <p className="mx-4 mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                                    {forwardError}
                                </p>
                            ) : null}
                            <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                                <p className="flex-1 text-xs text-muted-foreground">
                                    已选 {forwardSel.size} 个会话
                                </p>
                                <button
                                    type="button"
                                    disabled={
                                        forwardSel.size === 0 || forwardBusy
                                    }
                                    className="rounded-lg bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                                    onClick={() => void submitForward()}
                                >
                                    {forwardBusy ? "转发中…" : "转发"}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : null}

                {mergeView ? (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
                        role="dialog"
                        aria-modal="true"
                        aria-label="合并转发记录"
                        onKeyDown={(e) => {
                            if (e.key === "Escape") setMergeView(null);
                        }}
                        onClick={(e) => {
                            if (e.target === e.currentTarget)
                                setMergeView(null);
                        }}
                    >
                        <div className="flex max-h-[75vh] w-full max-w-md flex-col rounded-xl border border-border bg-card shadow-xl">
                            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                                <p className="flex-1 truncate text-sm font-semibold">
                                    {mergeView.title}
                                </p>
                                <button
                                    type="button"
                                    aria-label="关闭"
                                    className="rounded-md p-1 text-muted-foreground hover:bg-accent"
                                    onClick={() => setMergeView(null)}
                                >
                                    <XIcon className="size-4" />
                                </button>
                            </div>
                            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                                {mergeView.list.map((item) => (
                                    <div
                                        key={`${item.sender}:${item.createdAt}:${item.content.slice(0, 16)}`}
                                        className="flex flex-col gap-0.5 py-1.5"
                                    >
                                        <p className="text-xs text-muted-foreground">
                                            {item.sender}
                                            <span className="ml-2">
                                                {item.createdAt
                                                    .slice(5, 16)
                                                    .replace("T", " ")}
                                            </span>
                                        </p>
                                        <p className="whitespace-pre-wrap break-words text-sm">
                                            {messageLabel(
                                                item.kind,
                                                item.content,
                                            ) ?? item.content}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                ) : null}
            </>
        );
    };

    return ui.register("messages", Messages);
};
