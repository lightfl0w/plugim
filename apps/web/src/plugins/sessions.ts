import type { Plugin } from "@plugim/core";
import type { ChatMessage, SessionSummary } from "@plugim/protocol";
import type { RpcService } from "./connection";

const CURSOR_KEY = "plugim:cursors";

export interface SessionsService {
    summaries(): Record<string, SessionSummary>;
    unread(): Record<string, number>;
    cursors(): Record<string, number>;
    sessionOf(session: string): SessionSummary | null;
    refresh(): Promise<void>;
    track(session: string, seq: number): void;
    cursorOf(session: string): number;
    markRead(session: string, seq?: number): Promise<void>;
    mergeDelta(session: string, messages: ChatMessage[]): void;
    syncAll(): Promise<void>;
    onUpdate(cb: () => void): () => void;
}

const loadCursors = (): Record<string, number> => {
    try {
        const raw = localStorage.getItem(CURSOR_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter(([, v]) => Number.isFinite(Number(v)))
                .map(([k, v]) => [k, Number(v)]),
        );
    } catch {
        return {};
    }
};

const saveCursors = (cursors: Record<string, number>) => {
    try {
        localStorage.setItem(CURSOR_KEY, JSON.stringify(cursors));
    } catch {}
};

export const sessionsPlugin: Plugin = {
    name: "sessions",
    description: "会话未读、已读位点与增量同步",
    provides: ["sessions"],
    inject: ["rpc", "auth"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const auth = ctx.get<{ onChange(cb: () => void): () => void }>("auth");
        const listeners = new Set<() => void>();
        let state: Record<string, SessionSummary> = {};
        let cursors = loadCursors();
        let inflight: Promise<void> | null = null;

        const emit = () => {
            for (const cb of listeners) cb();
        };

        const persist = () => saveCursors(cursors);

        const refresh = async () => {
            if (rpc.status() !== "open") return;
            if (inflight) return inflight;
            inflight = (async () => {
                try {
                    const rows = (await rpc.call(
                        "chat.sessionList",
                        {},
                    )) as SessionSummary[];
                    const next: Record<string, SessionSummary> = {};
                    for (const row of rows) {
                        next[row.session] = row;
                        const known = cursors[row.session] ?? 0;
                        if (row.readSeq > known) {
                            cursors[row.session] = row.readSeq;
                        } else if (row.readSeq === 0 && known > row.lastSeq) {
                            cursors[row.session] = row.lastSeq;
                        }
                    }
                    state = next;
                    persist();
                    emit();
                } catch {
                    void 0;
                } finally {
                    inflight = null;
                }
            })();
            return inflight;
        };

        const track = (session: string, seq: number) => {
            if (!Number.isFinite(seq) || seq <= 0) return;
            const known = cursors[session] ?? 0;
            if (seq <= known) return;
            cursors[session] = seq;
            persist();
            const row = state[session];
            if (row) {
                state = {
                    ...state,
                    [session]: {
                        ...row,
                        lastSeq: Math.max(row.lastSeq, seq),
                        unread: Math.max(0, row.unread - 1),
                    },
                };
                emit();
            }
        };

        const markRead = async (session: string, seq?: number) => {
            const row = state[session];
            const target = seq ?? row?.lastSeq ?? cursors[session] ?? 0;
            if (target <= 0) return;
            if (row) {
                state = {
                    ...state,
                    [session]: {
                        ...row,
                        readSeq: target,
                        unread: 0,
                    },
                };
                emit();
            }
            try {
                const res = (await rpc.call("chat.read", {
                    session,
                    seq: target,
                })) as { seq: number };
                const known = cursors[session] ?? 0;
                if (res.seq > known) {
                    cursors[session] = res.seq;
                    persist();
                }
            } catch {
                void 0;
            }
        };

        const mergeDelta = (session: string, messages: ChatMessage[]) => {
            let max = cursors[session] ?? 0;
            for (const message of messages)
                if ((message.seq ?? 0) > max) max = message.seq ?? 0;
            if (max > (cursors[session] ?? 0)) {
                cursors[session] = max;
                persist();
            }
            const row = state[session];
            const last = messages[messages.length - 1];
            if (row && last)
                state = {
                    ...state,
                    [session]: { ...row, lastMessage: last },
                };
            emit();
        };

        const syncAll = async () => {
            if (rpc.status() !== "open") return;
            try {
                const result = (await rpc.call("sync.delta", {
                    cursors: Object.entries(cursors).map(([session, seq]) => ({
                        session,
                        seq,
                    })),
                    limit: 200,
                })) as {
                    sessions: {
                        session: string;
                        messages: ChatMessage[];
                        lastSeq: number;
                        readSeq: number;
                        hasMore: boolean;
                    }[];
                };
                for (const row of result.sessions) {
                    mergeDelta(row.session, row.messages);
                    if (row.readSeq > (cursors[row.session] ?? 0)) {
                        cursors[row.session] = row.readSeq;
                        persist();
                    }
                }
                for (const row of result.sessions)
                    ctx.emit("sync:messages", {
                        session: row.session,
                        messages: row.messages,
                        hasMore: row.hasMore,
                    });
            } catch {
                void 0;
            }
            await refresh();
        };

        const unstatus = rpc.onStatus((next) => {
            if (next !== "open") return;
            void syncAll();
        });
        const unauth = auth.onChange(() => {
            cursors = loadCursors();
            state = {};
            emit();
        });
        void refresh();

        ctx.provide<SessionsService>("sessions", {
            summaries: () => state,
            unread: () =>
                Object.fromEntries(
                    Object.entries(state)
                        .filter(([, row]) => row.unread > 0)
                        .map(([session, row]) => [session, row.unread]),
                ),
            cursors: () => ({ ...cursors }),
            sessionOf: (session) => state[session] ?? null,
            refresh,
            track,
            cursorOf: (session) => cursors[session] ?? 0,
            markRead,
            mergeDelta,
            syncAll,
            onUpdate(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });
        return () => {
            unstatus();
            unauth();
        };
    },
};
