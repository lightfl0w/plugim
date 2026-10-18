import { Context } from "@plugim/core";
import type { SessionSummary } from "@plugim/protocol";
import { describe, expect, it, vi } from "vitest";
import type { RpcService } from "../src/plugins/connection";
import { type SessionsService, sessionsPlugin } from "../src/plugins/sessions";

const summary = (
    session: string,
    lastSeq: number,
    readSeq: number,
    unread: number,
): SessionSummary => ({
    session,
    lastSeq,
    readSeq,
    unread,
    lastMessage: null,
});

const makeSessions = (
    rows: SessionSummary[],
    handlers: {
        onRead?: (session: string, seq: number) => void;
        onDelta?: (cursors: { session: string; seq: number }[]) => unknown;
    } = {},
) => {
    const ctx = new Context();
    let status: "open" | "closed" = "open";
    const statusListeners = new Set<(s: string) => void>();
    ctx.provide<RpcService>("rpc", {
        call: async (method: string, params?: unknown) => {
            if (method === "chat.sessionList") return rows;
            if (method === "chat.read") {
                const p = params as { session: string; seq: number };
                handlers.onRead?.(p.session, p.seq);
                return { seq: p.seq, at: new Date().toISOString() };
            }
            if (method === "sync.delta") {
                const p = params as {
                    cursors: { session: string; seq: number }[];
                };
                return handlers.onDelta?.(p.cursors) ?? { sessions: [] };
            }
            return null;
        },
        status: () => status,
        onStatus: (cb) => {
            statusListeners.add(cb as (s: string) => void);
            return () => statusListeners.delete(cb as (s: string) => void);
        },
    });
    ctx.provide("auth", { onChange: () => () => undefined });
    ctx.plugin(sessionsPlugin);
    return ctx.start().then(() => ({
        sessions: ctx.get<SessionsService>("sessions"),
        setStatus: (next: "open" | "closed") => {
            status = next;
            for (const cb of statusListeners) cb(next);
        },
    }));
};

describe("sessions service", () => {
    it("exposes server unread counts", async () => {
        const { sessions } = await makeSessions([
            summary("p2p:alice", 4, 1, 3),
            summary("p2p:bob", 2, 2, 0),
        ]);
        await vi.waitFor(() =>
            expect(sessions.unread()).toEqual({ "p2p:alice": 3 }),
        );
    });

    it("clears unread when a session is marked read", async () => {
        const reads: { session: string; seq: number }[] = [];
        const { sessions } = await makeSessions(
            [summary("p2p:alice", 7, 0, 7)],
            { onRead: (session, seq) => reads.push({ session, seq }) },
        );
        await vi.waitFor(() =>
            expect(sessions.unread()).toEqual({ "p2p:alice": 7 }),
        );
        await sessions.markRead("p2p:alice");
        expect(sessions.unread()).toEqual({});
        expect(reads).toEqual([{ session: "p2p:alice", seq: 7 }]);
    });

    it("advances the stored cursor when messages arrive", async () => {
        const { sessions } = await makeSessions([
            summary("p2p:alice", 2, 2, 0),
        ]);
        await vi.waitFor(() => expect(sessions.cursorOf("p2p:alice")).toBe(2));
        sessions.track("p2p:alice", 5);
        expect(sessions.cursorOf("p2p:alice")).toBe(5);
        sessions.track("p2p:alice", 3);
        expect(sessions.cursorOf("p2p:alice")).toBe(5);
    });

    it("pulls deltas on reconnect using stored cursors", async () => {
        const seen: { session: string; seq: number }[][] = [];
        const { sessions, setStatus } = await makeSessions(
            [summary("p2p:alice", 1, 1, 0)],
            {
                onDelta: (cursors) => {
                    seen.push(cursors);
                    return {
                        sessions: [
                            {
                                session: "p2p:alice",
                                messages: [
                                    {
                                        id: "m9",
                                        session: "p2p:alice",
                                        sender: "alice",
                                        content: "back",
                                        createdAt: new Date().toISOString(),
                                        seq: 9,
                                    },
                                ],
                                lastSeq: 9,
                                readSeq: 1,
                                hasMore: false,
                            },
                        ],
                    };
                },
            },
        );
        await vi.waitFor(() => expect(sessions.cursorOf("p2p:alice")).toBe(1));
        setStatus("closed");
        setStatus("open");
        await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
        expect(seen[seen.length - 1]).toEqual([
            { session: "p2p:alice", seq: 1 },
        ]);
        await vi.waitFor(() => expect(sessions.cursorOf("p2p:alice")).toBe(9));
    });
});
