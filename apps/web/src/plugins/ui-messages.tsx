import type { Plugin } from "@plugim/core";
import type { ChatMessage, GroupInfo } from "@plugim/protocol";
import {
    AlertCircleIcon,
    ArrowDownIcon,
    ClockIcon,
    CopyIcon,
    CornerUpLeftIcon,
    FileIcon,
    MegaphoneIcon,
    RotateCcwIcon,
    XIcon,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
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
import type { PendingEvent, PendingMessage, SenderService } from "./sender";
import type { UiService } from "./ui";
import { formatBytes } from "./ui-mediaviewer";

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

const isImage = (content: string) => content.startsWith("data:image/");

const mediaKind = (message: ChatMessage) =>
    message.kind ??
    (message.content.startsWith("data:")
        ? message.content.startsWith("data:audio/")
            ? "audio"
            : message.content.startsWith("data:video/")
              ? "video"
              : isImage(message.content)
                ? "image"
                : "file"
        : "text");

function contentPreview(message: ChatMessage): string {
    if (message.recalledAt) return "[消息已撤回]";
    switch (mediaKind(message)) {
        case "image":
            return "[图片]";
        case "audio":
            return "[语音]";
        case "video":
            return "[视频]";
        case "file":
            return `[文件] ${message.file?.name ?? ""}`;
        default:
            return message.content.replace(/\s+/g, " ");
    }
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

export const uiMessagesPlugin: Plugin = {
    name: "ui-messages",
    description: "消息流展示(乐观发送 / 回到底部 / 搜索 / 引用 / @提及)",
    inject: ["ui", "auth", "rpc", "cache", "sender"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const rpc = ctx.get<RpcService>("rpc");
        const cache = ctx.get<CacheService>("cache");
        const sender = ctx.get<SenderService>("sender");

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
            const [searchResults, setSearchResults] = useState<ChatMessage[]>(
                [],
            );
            const [highlightId, setHighlightId] = useState<string | null>(null);
            const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
            const [peerReadAt, setPeerReadAt] = useState<string | null>(null);
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
                });
                return () => {
                    void dispose();
                };
            }, []);

            useEffect(() => {
                const dispose = ctx.on("chat:pending", (payload) => {
                    const { type, pending: item } = payload as PendingEvent;
                    setPending((prev) => {
                        const rest = prev.filter(
                            (x) => x.tempId !== item.tempId,
                        );
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
                void rpc
                    .call("receipt.read", { session })
                    .catch(() => undefined);
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
                            if (!alive || sessionRef.current !== session)
                                return;
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
                    const message = (payload as { message: ChatMessage })
                        .message;
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
                const distance =
                    el.scrollHeight - el.scrollTop - el.clientHeight;
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
                        nodes.push(
                            message.content.slice(lastIndex, match.index),
                        );
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
                                “{searchQuery}” 的搜索结果{" "}
                                {searchResults.length} 条
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
                                        onClick={() =>
                                            jumpToMessage(message.id)
                                        }
                                    >
                                        <span className="text-xs text-muted-foreground">
                                            {message.sender} ·{" "}
                                            {formatStamp(message.createdAt)}
                                        </span>
                                        <span className="truncate text-sm">
                                            {message.content}
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
                                                media === "video";
                                            return (
                                                <Message
                                                    key={message.id}
                                                    id={`msg-${message.id}`}
                                                    align={
                                                        mine ? "end" : "start"
                                                    }
                                                    className={cn(
                                                        "py-0.5 transition-colors",
                                                        highlightId ===
                                                            message.id &&
                                                            "rounded-xl bg-primary/10",
                                                    )}
                                                >
                                                    <MessageAvatar>
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
                                                            onContextMenu={(
                                                                e,
                                                            ) => {
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
                                                        message.id ===
                                                            lastOwnId ? (
                                                            <p className="px-1 text-[10px] text-muted-foreground">
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
                                                        {item.content.startsWith(
                                                            "data:",
                                                        )
                                                            ? item.kind ===
                                                              "file"
                                                                ? `[文件] ${item.file?.name ?? ""}`
                                                                : `[${item.kind === "audio" ? "语音" : item.kind === "video" ? "视频" : "图片"}]`
                                                            : item.content}
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
                                        {newCount > 99 ? "99+" : newCount}{" "}
                                        条新消息
                                    </span>
                                ) : null}
                                <ArrowDownIcon className="size-4" />
                            </button>
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
                            {isImage(menu.message.content)
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
                </>
            );
        };

        return ui.register("messages", Messages);
    },
};
