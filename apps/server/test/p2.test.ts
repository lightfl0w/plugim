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

describe("session meta", () => {
    it("pins a session", async () => {
        const { app, ua } = await friendPair("pa", "pb");
        const first = (await app.call(
            "chat.session.meta",
            { session: "p2p:pb", pinned: true },
            ua.user,
        )) as { session: string; pinned: boolean };
        expect(first.pinned).toBe(true);
        await app.call(
            "message.send",
            { session: "p2p:pb", content: "hi" },
            ua.user,
        );
        const list = (await app.call("chat.sessionList", {}, ua.user)) as {
            session: string;
            pinned: boolean;
        }[];
        const row = list.find((item) => item.session === "p2p:pb");
        expect(row?.pinned).toBe(true);
    });

    it("unpins", async () => {
        const { app, ua } = await friendPair("ua2", "ub2");
        await app.call(
            "chat.session.meta",
            { session: "p2p:ub2", pinned: true },
            ua.user,
        );
        const off = (await app.call(
            "chat.session.meta",
            { session: "p2p:ub2", pinned: false },
            ua.user,
        )) as { pinned: boolean };
        expect(off.pinned).toBe(false);
    });

    it("rejects meta for invisible sessions", async () => {
        const { app, ua } = await friendPair("pa3", "pb3");
        const uc = await app.register("pc3");
        await expect(
            app.call(
                "chat.session.meta",
                { session: `p2p:${uc.user.username}`, pinned: true },
                ua.user,
            ),
        ).rejects.toThrow();
    });
});

describe("message search filters", () => {
    it("filters by sender", async () => {
        const { app, ua, ub } = await friendPair("fsa", "fsb");
        await send(app, "p2p:fsb", "alpha hello", ua.user);
        await send(app, "p2p:fsa", "beta hello", ub.user);
        await send(app, "p2p:fsb", "gamma hello", ua.user);
        const onlyUa = (await app.call(
            "message.search",
            { keyword: "hello", sender: "fsa", limit: 50 },
            ua.user,
        )) as { hits: { sender: string }[]; total: number };
        expect(onlyUa.total).toBe(2);
        for (const hit of onlyUa.hits) expect(hit.sender).toBe("fsa");
    });

    it("filters by time range", async () => {
        const { app, ua } = await friendPair("tsa", "tsb");
        const first = (await app.call(
            "message.send",
            { session: "p2p:tsb", content: "old hello" },
            ua.user,
        )) as {
            seq: number;
        };
        expect(first.seq).toBeGreaterThan(0);
        const detail = (await app.call(
            "history.list",
            { session: "p2p:tsb", limit: 1 },
            ua.user,
        )) as { createdAt: string }[];
        const at = detail[0]?.createdAt ?? "";
        expect(at).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, 20));
        await send(app, "p2p:tsb", "future hello", ua.user);
        const exact = (await app.call(
            "message.search",
            { keyword: "hello", from: at, to: at, limit: 50 },
            ua.user,
        )) as { hits: { content: string }[]; total: number };
        expect(exact.total).toBe(1);
        expect(exact.hits[0]?.content).toBe("old hello");
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const none = (await app.call(
            "message.search",
            { keyword: "hello", from: future, limit: 50 },
            ua.user,
        )) as { total: number };
        expect(none.total).toBe(0);
        const past = new Date(Date.parse(at) - 1).toISOString();
        const pastOnly = (await app.call(
            "message.search",
            { keyword: "hello", to: past, limit: 50 },
            ua.user,
        )) as { total: number };
        expect(pastOnly.total).toBe(0);
    });

    it("scopes search to a session with sender filter", async () => {
        const { app, ua, ub } = await friendPair("ssa", "ssb");
        await send(app, "p2p:ssb", "scoped hello", ua.user);
        await send(app, "p2p:ssa", "other hello", ub.user);
        const result = (await app.call(
            "message.search",
            { keyword: "hello", session: "p2p:ssb", sender: "ssa", limit: 50 },
            ua.user,
        )) as { total: number };
        expect(result.total).toBe(1);
    });
});
