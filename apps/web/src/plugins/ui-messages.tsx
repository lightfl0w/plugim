import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
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

function formatTime(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabel(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const startOf = (x: Date) =>
        new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(now) - startOf(d)) / 86_400_000);
    if (diff === 0) return "今天";
    if (diff === 1) return "昨天";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

function groupMessages(messages: ChatMessage[], me: string): Group[] {
    const groups: Group[] = [];
    for (const message of messages) {
        const last = groups[groups.length - 1];
        if (last && last.sender === message.sender) {
            last.items.push(message);
        } else {
            groups.push({
                sender: message.sender,
                mine: message.sender === me,
                items: [message],
            });
        }
    }
    return groups;
}

type Row =
    | { kind: "divider"; key: string; label: string }
    | { kind: "group"; key: string; group: Group };

function toRows(groups: Group[]): Row[] {
    const rows: Row[] = [];
    let lastDay = "";
    for (const group of groups) {
        const label = dayLabel(group.items[0].createdAt);
        if (label !== lastDay) {
            rows.push({
                kind: "divider",
                key: `d-${label}-${group.items[0].id}`,
                label,
            });
            lastDay = label;
        }
        rows.push({ kind: "group", key: group.items[0].id, group });
    }
    return rows;
}

export const uiMessagesPlugin: Plugin = {
    name: "ui-messages",
    description: "消息流展示(本地缓存 / 分页 / 撤回)",
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
            const bottomRef = useRef<HTMLDivElement>(null);
            const scrollRef = useRef<HTMLDivElement>(null);
            const sessionRef = useRef(session);
            const loadingRef = useRef(false);
            const skipScrollRef = useRef(false);
            const prevCountRef = useRef(0);
            const lastScrollTopRef = useRef(0);
            const user = auth.user();
            const me = user?.username ?? "";

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
                } catch {
                }
            };

            const canRecall = (message: ChatMessage) =>
                message.sender === me &&
                !message.recalledAt &&
                Date.now() - Date.parse(message.createdAt) <= RECALL_WINDOW_MS;

            const rows = toRows(groupMessages(messages, me));

            return (
                <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
                >
                    {loadingOlder ? (
                        <p className="py-1 text-center text-xs text-muted-foreground">
                            正在加载更早的消息...
                        </p>
                    ) : null}
                    {rows.map((row) =>
                        row.kind === "divider" ? (
                            <div
                                key={row.key}
                                className="flex items-center gap-3 py-1"
                            >
                                <span className="h-px flex-1 bg-border" />
                                <span className="text-xs text-muted-foreground">
                                    {row.label}
                                </span>
                                <span className="h-px flex-1 bg-border" />
                            </div>
                        ) : (
                            <MessageGroup key={row.key}>
                                {row.group.items.map((message) => {
                                    const mine = row.group.mine;
                                    return (
                                        <Message
                                            key={message.id}
                                            align={mine ? "end" : "start"}
                                        >
                                            <MessageAvatar>
                                                <UserAvatar
                                                    name={message.sender}
                                                />
                                            </MessageAvatar>
                                            <MessageContent>
                                                <MessageHeader>
                                                    {message.sender}{" "}
                                                    {formatTime(
                                                        message.createdAt,
                                                    )}
                                                    {canRecall(message) ? (
                                                        <button
                                                            type="button"
                                                            className="ml-1 text-xs text-muted-foreground/70 hover:text-foreground"
                                                            onClick={() =>
                                                                void recall(
                                                                    message,
                                                                )
                                                            }
                                                        >
                                                            撤回
                                                        </button>
                                                    ) : null}
                                                </MessageHeader>
                                                {message.recalledAt ? (
                                                    <p
                                                        className={
                                                            mine
                                                                ? "text-right text-xs italic text-muted-foreground"
                                                                : "text-xs italic text-muted-foreground"
                                                        }
                                                    >
                                                        消息已撤回
                                                    </p>
                                                ) : (
                                                    <Bubble
                                                        variant={
                                                            mine
                                                                ? "default"
                                                                : "muted"
                                                        }
                                                        align={
                                                            mine
                                                                ? "end"
                                                                : "start"
                                                        }
                                                    >
                                                        <BubbleContent
                                                            className={
                                                                mine
                                                                    ? "rounded-2xl rounded-br-none"
                                                                    : "rounded-2xl rounded-bl-none"
                                                            }
                                                        >
                                                            {message.content}
                                                        </BubbleContent>
                                                    </Bubble>
                                                )}
                                            </MessageContent>
                                        </Message>
                                    );
                                })}
                            </MessageGroup>
                        ),
                    )}
                    <div ref={bottomRef} />
                </div>
            );
        };

        return ui.register("messages", Messages);
    },
};
