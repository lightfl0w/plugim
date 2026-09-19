import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { CopyIcon, CornerUpLeftIcon, RotateCcwIcon } from "lucide-react";
import type { ReactNode } from "react";
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
import type { AuthService } from "./auth";
import type { CacheService } from "./cache";
import type { ConnStatus, RpcService } from "./connection";
import type { UiService } from "./ui";

const PAGE_SIZE = 30;
const RECALL_WINDOW_MS = 2 * 60 * 1000;
const STAMP_GAP_MS = 5 * 60 * 1000;

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

function contentPreview(message: ChatMessage): string {
    if (message.recalledAt) return "[消息已撤回]";
    if (isImage(message.content)) return "[图片]";
    return message.content.replace(/\s+/g, " ");
}

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
    description: "消息流展示(QQ 风格气泡 / 时间规则 / 引用 / 撤回)",
    inject: ["ui", "auth", "rpc", "cache"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const rpc = ctx.get<RpcService>("rpc");
        const cache = ctx.get<CacheService>("cache");

        const Messages = () => {
            const [session, setSession] = useState("general");
            const [messages, setMessages] = useState<ChatMessage[]>([]);
            const [status, setStatus] = useState<ConnStatus>(rpc.status());
            const [loadingOlder, setLoadingOlder] = useState(false);
            const [hasMore, setHasMore] = useState(true);
            const [copiedId, setCopiedId] = useState<string | null>(null);
            const [menu, setMenu] = useState<{
                x: number;
                y: number;
                message: ChatMessage;
            } | null>(null);
            const bottomRef = useRef<HTMLDivElement>(null);
            const scrollRef = useRef<HTMLDivElement>(null);
            const sessionRef = useRef(session);
            const loadingRef = useRef(false);
            const skipScrollRef = useRef(false);
            const prevCountRef = useRef(0);
            const lastScrollTopRef = useRef(0);
            const user = auth.user();
            const me = user?.username ?? "";
            const isP2p = session.startsWith("p2p:");

            useEffect(() => rpc.onStatus(setStatus), []);

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

            useEffect(() => {
                const dispose = ctx.on("ui:chat:open", (payload) => {
                    setSession((payload as { session: string }).session);
                });
                return () => {
                    void dispose();
                };
            }, []);

            useEffect(() => {
                sessionRef.current = session;
                let alive = true;
                setHasMore(true);
                prevCountRef.current = 0;
                setMessages([]);

                if (!me) return undefined;

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
                if (skipScrollRef.current) {
                    skipScrollRef.current = false;
                    prevCountRef.current = messages.length;
                    return;
                }
                if (messages.length > prevCountRef.current) {
                    requestAnimationFrame(() => {
                        bottomRef.current?.scrollIntoView({
                            behavior: "smooth",
                        });
                    });
                }
                prevCountRef.current = messages.length;
            }, [messages.length]);

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

            const recall = async (message: ChatMessage) => {
                try {
                    await rpc.call("message.recall", { id: message.id });
                } catch {}
            };

            const copy = async (message: ChatMessage) => {
                try {
                    await navigator.clipboard.writeText(message.content);
                    setCopiedId(message.id);
                    setTimeout(() => setCopiedId(null), 1500);
                } catch {}
            };

            const reply = (message: ChatMessage) => {
                ctx.emit("ui:chat:quote", {
                    sender: message.sender,
                    content: contentPreview(message),
                });
            };

            const canRecall = (message: ChatMessage) =>
                message.sender === me &&
                !message.recalledAt &&
                Date.now() - Date.parse(message.createdAt) <= RECALL_WINDOW_MS;

            const rows = toRows(messages, me);

            const actionButton = (
                key: string,
                icon: ReactNode,
                title: string,
                onClick: () => void,
            ) => (
                <button
                    key={key}
                    type="button"
                    title={title}
                    onClick={onClick}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground dark:hover:bg-white/10"
                >
                    {icon}
                </button>
            );

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

            return (
                <>
                    <div
                        ref={scrollRef}
                        onScroll={handleScroll}
                        className="flex min-h-0 flex-1 flex-col gap-1 overflow-x-clip overflow-y-auto px-4 py-3"
                    >
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
                                        const image = isImage(message.content);
                                        return (
                                            <Message
                                                key={message.id}
                                                align={mine ? "end" : "start"}
                                                className="py-0.5"
                                            >
                                                <MessageAvatar>
                                                    <UserAvatar
                                                        name={message.sender}
                                                    />
                                                </MessageAvatar>
                                                <MessageContent>
                                                    {!mine && !isP2p ? (
                                                        <MessageHeader>
                                                            {message.sender}
                                                        </MessageHeader>
                                                    ) : null}
                                                    <Bubble
                                                        variant={
                                                            image
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
                                                        className="group/msg"
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
                                                                image
                                                                    ? "p-0.5"
                                                                    : mine
                                                                      ? "rounded-xl rounded-br-sm"
                                                                      : "rounded-xl rounded-bl-sm"
                                                            }
                                                        >
                                                            {image ? (
                                                                <a
                                                                    href={
                                                                        message.content
                                                                    }
                                                                    target="_blank"
                                                                    rel="noreferrer"
                                                                    title="点击查看大图"
                                                                >
                                                                    <img
                                                                        src={
                                                                            message.content
                                                                        }
                                                                        alt="图片"
                                                                        loading="lazy"
                                                                        className="max-h-80 w-auto max-w-full cursor-zoom-in rounded-lg"
                                                                    />
                                                                </a>
                                                            ) : (
                                                                <p className="whitespace-pre-wrap">
                                                                    {
                                                                        message.content
                                                                    }
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
                                                        <div
                                                            className={
                                                                mine
                                                                    ? "absolute top-1/2 right-full z-10 mr-2 hidden -translate-y-1/2 gap-0.5 rounded-lg bg-white p-0.5 shadow-md ring-1 ring-black/5 group-hover/msg:flex dark:bg-popover dark:ring-white/10"
                                                                    : "absolute top-1/2 left-full z-10 ml-2 hidden -translate-y-1/2 gap-0.5 rounded-lg bg-white p-0.5 shadow-md ring-1 ring-black/5 group-hover/msg:flex dark:bg-popover dark:ring-white/10"
                                                            }
                                                        >
                                                            {actionButton(
                                                                "quote",
                                                                <CornerUpLeftIcon className="size-4" />,
                                                                "回复",
                                                                () =>
                                                                    reply(
                                                                        message,
                                                                    ),
                                                            )}
                                                            {!image
                                                                ? actionButton(
                                                                      "copy",
                                                                      copiedId ===
                                                                          message.id ? (
                                                                          <span className="text-xs">
                                                                              已复制
                                                                          </span>
                                                                      ) : (
                                                                          <CopyIcon className="size-4" />
                                                                      ),
                                                                      "复制",
                                                                      () =>
                                                                          void copy(
                                                                              message,
                                                                          ),
                                                                  )
                                                                : null}
                                                            {canRecall(message)
                                                                ? actionButton(
                                                                      "recall",
                                                                      <RotateCcwIcon className="size-4" />,
                                                                      "撤回",
                                                                      () =>
                                                                          void recall(
                                                                              message,
                                                                          ),
                                                                  )
                                                                : null}
                                                        </div>
                                                    </Bubble>
                                                </MessageContent>
                                            </Message>
                                        );
                                    })}
                                </MessageGroup>
                            ),
                        )}
                        <div ref={bottomRef} />
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
