import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const friendPair = async (a: string, b: string) => {
    const app = await createTestApp();
    const ua = await app.register(a);
    const ub = await app.register(b);
    await app.call("friend.request", { username: b }, ua.user);
    await app.call("friend.accept", { username: a }, ub.user);
    return { app, ua, ub };
};

const send = async (
    app: Awaited<ReturnType<typeof createTestApp>>,
    session: string,
    content: string,
    user: Parameters<Awaited<ReturnType<typeof createTestApp>>["call"]>[2],
) =>
    (await app.call("message.send", { session, content }, user)) as {
        id: string;
        seq: number;
    };

describe("message seq", () => {
    it("assigns a monotonic seq per session", async () => {
        const { app, ua, ub } = await friendPair("sa", "sb");
        const first = await send(app, "p2p:sb", "one", ua.user);
        const second = await send(app, "p2p:sa", "two", ub.user);
        const third = await send(app, "p2p:sb", "three", ua.user);
        expect(first.seq).toBe(1);
        expect(second.seq).toBe(2);
        expect(third.seq).toBe(3);
    });

    it("keeps seq independent across sessions", async () => {
        const { app, ua } = await friendPair("ta", "tb");
        const other = await app.register("tc");
        await app.call("friend.request", { username: "tc" }, ua.user);
        await app.call("friend.accept", { username: "ta" }, other.user);
        await send(app, "p2p:tb", "a", ua.user);
        await send(app, "p2p:tb", "b", ua.user);
        const other1 = await send(app, "p2p:tc", "c", ua.user);
        expect(other1.seq).toBe(1);
    });

    it("pages by seq without gaps or repeats", async () => {
        const { app, ua } = await friendPair("ua2", "ub2");
        const ids: string[] = [];
        for (let i = 0; i < 12; i += 1)
            ids.push((await send(app, "p2p:ub2", `s${i}`, ua.user)).id);
        const head = (await app.call(
            "history.list",
            { session: "p2p:ub2", limit: 5 },
            ua.user,
        )) as { id: string; seq: number }[];
        expect(head.map((m) => m.seq)).toEqual([8, 9, 10, 11, 12]);
        const older = (await app.call(
            "history.list",
            { session: "p2p:ub2", limit: 5, beforeSeq: head[0].seq },
            ua.user,
        )) as { id: string; seq: number }[];
        expect(older.map((m) => m.seq)).toEqual([3, 4, 5, 6, 7]);
        const newer = (await app.call(
            "history.list",
            { session: "p2p:ub2", limit: 3, afterSeq: older[0].seq },
            ua.user,
        )) as { seq: number }[];
        expect(newer.map((m) => m.seq)).toEqual([4, 5, 6]);
        expect([...older, ...head].map((m) => m.id)).toEqual(ids.slice(2));
    });
});

describe("read cursors", () => {
    it("keeps unread counts on the server and clears on read", async () => {
        const { app, ua, ub } = await friendPair("ra", "rb");
        await send(app, "p2p:rb", "m1", ua.user);
        await send(app, "p2p:rb", "m2", ua.user);
        const before = (await app.call(
            "chat.sessionList",
            { sessions: ["p2p:ra"] },
            ub.user,
        )) as { session: string; unread: number; lastSeq: number }[];
        expect(before[0].unread).toBe(2);
        expect(before[0].lastSeq).toBe(2);
        await app.call("chat.read", { session: "p2p:ra", seq: 2 }, ub.user);
        const after = (await app.call(
            "chat.sessionList",
            { sessions: ["p2p:ra"] },
            ub.user,
        )) as { unread: number; readSeq: number }[];
        expect(after[0].unread).toBe(0);
        expect(after[0].readSeq).toBe(2);
    });

    it("does not count own messages as unread", async () => {
        const { app, ua } = await friendPair("sa2", "sb2");
        await send(app, "p2p:sb2", "mine", ua.user);
        const rows = (await app.call(
            "chat.sessionList",
            { sessions: ["p2p:sb2"] },
            ua.user,
        )) as { unread: number }[];
        expect(rows[0].unread).toBe(0);
    });

    it("never moves the cursor backwards", async () => {
        const { app, ua, ub } = await friendPair("ca", "cb");
        for (let i = 0; i < 3; i += 1)
            await send(app, "p2p:cb", `c${i}`, ua.user);
        await app.call("chat.read", { session: "p2p:ca", seq: 3 }, ub.user);
        const back = (await app.call(
            "chat.read",
            { session: "p2p:ca", seq: 1 },
            ub.user,
        )) as { seq: number };
        expect(back.seq).toBe(3);
    });

    it("clamps the cursor to the session head", async () => {
        const { app, ua, ub } = await friendPair("da", "db");
        await send(app, "p2p:db", "one", ua.user);
        const res = (await app.call(
            "chat.read",
            { session: "p2p:da", seq: 9999 },
            ub.user,
        )) as { seq: number };
        expect(res.seq).toBe(1);
    });

    it("notifies the peer when the cursor moves", async () => {
        const { app, ua, ub } = await friendPair("ea", "eb");
        await send(app, "p2p:eb", "hi", ua.user);
        await app.call("chat.read", { session: "p2p:ea", seq: 1 }, ub.user);
        const events = app.eventsFor(ub.user.id, "read:update");
        expect(events.length).toBeGreaterThan(0);
        const payload = (
            events[events.length - 1] as { payload: { seq: number } }
        ).payload;
        expect(payload.seq).toBe(1);
    });

    it("rejects reading a session the user cannot see", async () => {
        const { app } = await friendPair("fa", "fb");
        const stranger = await app.register("fc");
        await expect(
            app.call("chat.read", { session: "p2p:fb" }, stranger.user),
        ).rejects.toThrow();
    });
});

describe("sync delta", () => {
    it("returns only messages after the cursor", async () => {
        const { app, ua, ub } = await friendPair("ga", "gb");
        for (let i = 0; i < 5; i += 1)
            await send(app, "p2p:gb", `g${i}`, ua.user);
        const result = (await app.call(
            "sync.delta",
            { cursors: [{ session: "p2p:ga", seq: 3 }] },
            ub.user,
        )) as {
            sessions: {
                session: string;
                messages: { seq: number }[];
                lastSeq: number;
                hasMore: boolean;
            }[];
        };
        expect(result.sessions).toHaveLength(1);
        expect(result.sessions[0].session).toBe("p2p:ga");
        expect(result.sessions[0].messages.map((m) => m.seq)).toEqual([4, 5]);
        expect(result.sessions[0].lastSeq).toBe(5);
        expect(result.sessions[0].hasMore).toBe(false);
    });

    it("flags hasMore when the page is capped", async () => {
        const { app, ua, ub } = await friendPair("ia", "ib");
        for (let i = 0; i < 8; i += 1)
            await send(app, "p2p:ib", `i${i}`, ua.user);
        const result = (await app.call(
            "sync.delta",
            { cursors: [{ session: "p2p:ia", seq: 0 }], limit: 3 },
            ub.user,
        )) as {
            sessions: {
                messages: unknown[];
                hasMore: boolean;
                lastSeq: number;
            }[];
        };
        expect(result.sessions[0].messages).toHaveLength(3);
        expect(result.sessions[0].hasMore).toBe(true);
        expect(result.sessions[0].lastSeq).toBe(3);
    });

    it("covers every visible session when no cursor is given", async () => {
        const { app, ua, ub } = await friendPair("ja", "jb");
        await send(app, "p2p:jb", "hello", ua.user);
        const result = (await app.call("sync.delta", {}, ub.user)) as {
            sessions: { session: string }[];
        };
        const sessions = result.sessions.map((row) => row.session);
        expect(sessions).toContain("p2p:ja");
    });

    it("skips sessions the caller cannot access", async () => {
        const { app } = await friendPair("ka", "kb");
        const stranger = await app.register("kc");
        const result = (await app.call(
            "sync.delta",
            { cursors: [{ session: "p2p:kb", seq: 0 }] },
            stranger.user,
        )) as { sessions: unknown[] };
        expect(result.sessions).toHaveLength(0);
    });
});
