import "fake-indexeddb/auto";
import { Context } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { type CacheService, cachePlugin } from "../src/plugins/cache";

const stamp = (id: string) =>
    new Date(
        1_700_000_000_000 +
            (id.charCodeAt(id.length - 1) % 26) * 60_000 +
            id.length * 1000,
    ).toISOString();

const msg = (
    id: string,
    session: string,
    overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
    id,
    session,
    sender: "a",
    content: `content-${id}`,
    createdAt: stamp(id),
    ...overrides,
});

let cache: CacheService;

beforeAll(async () => {
    const ctx = new Context();
    ctx.plugin(cachePlugin);
    await ctx.start();
    cache = ctx.get<CacheService>("cache");
});

describe("message cache", () => {
    it("stores and returns messages sorted by time", async () => {
        await cache.putMessages("t1", "s1", [msg("b", "s1"), msg("a", "s1")]);
        const rows = await cache.getMessages("t1", "s1");
        expect(rows.map((m) => m.id)).toEqual(["a", "b"]);
    });

    it("dedupes by id across writes", async () => {
        await cache.putMessages("t2", "s1", [msg("a", "s1")]);
        await cache.putMessages("t2", "s1", [
            msg("a", "s1", { content: "updated" }),
        ]);
        const rows = await cache.getMessages("t2", "s1");
        expect(rows).toHaveLength(1);
        expect(rows[0].content).toBe("updated");
    });

    it("keeps sessions and owners isolated", async () => {
        await cache.putMessages("t3", "s1", [msg("a", "s1")]);
        await cache.putMessages("t3", "s2", [msg("b", "s2")]);
        await cache.putMessages("t4", "s1", [msg("c", "s1")]);
        expect((await cache.getMessages("t3", "s1")).map((m) => m.id)).toEqual([
            "a",
        ]);
        expect((await cache.getMessages("t4", "s1")).map((m) => m.id)).toEqual([
            "c",
        ]);
    });

    it("marks recalled messages in cache and preview", async () => {
        await cache.putMessages("t5", "s1", [msg("a", "s1"), msg("b", "s1")]);
        const at = new Date().toISOString();
        await cache.recallMessage("t5", "s1", "b", at);
        const rows = await cache.getMessages("t5", "s1");
        expect(rows.find((m) => m.id === "b")?.recalledAt).toBe(at);
        const previews = await cache.getPreviews("t5");
        expect(previews.s1?.content).toBe("[消息已撤回]");
    });

    it("leaves preview untouched when recalling a non-latest message", async () => {
        await cache.putMessages("t6", "s1", [msg("a", "s1"), msg("b", "s1")]);
        await cache.recallMessage("t6", "s1", "a", new Date().toISOString());
        expect((await cache.getPreviews("t6")).s1?.id).toBe("b");
    });

    it("searches cached content case-insensitively, newest first", async () => {
        await cache.putMessages("t7", "s1", [
            msg("a", "s1", { content: "Hello World" }),
            msg("b", "s1", { content: "other" }),
            msg("c", "s1", { content: "say hello again" }),
        ]);
        const hits = await cache.searchMessages("t7", "s1", "HELLO");
        expect(hits.map((m) => m.id)).toEqual(["c", "a"]);
        expect(await cache.searchMessages("t7", "s1", "   ")).toEqual([]);
        expect(await cache.searchMessages("t7", "s1", "zzz")).toEqual([]);
    });

    it("skips recalled messages in search", async () => {
        await cache.putMessages("t8", "s1", [
            msg("a", "s1", { content: "hello" }),
        ]);
        await cache.recallMessage("t8", "s1", "a", new Date().toISOString());
        expect(await cache.searchMessages("t8", "s1", "hello")).toEqual([]);
    });
});

describe("session previews, unread and pinned", () => {
    it("tracks the newest message per session", async () => {
        await cache.putMessages("p1", "s1", [msg("a", "s1")]);
        await cache.putMessages("p1", "s2", [msg("z", "s2")]);
        await cache.putMessages("p1", "s1", [msg("b", "s1")]);
        const previews = await cache.getPreviews("p1");
        expect(previews.s1?.id).toBe("b");
        expect(previews.s2?.id).toBe("z");
    });

    it("ignores older messages when updating previews", async () => {
        await cache.putMessages("p2", "s1", [msg("n", "s1")]);
        await cache.putMessages("p2", "s1", [
            msg("o", "s1", { createdAt: "2000-01-01T00:00:00.000Z" }),
        ]);
        expect((await cache.getPreviews("p2")).s1?.id).toBe("n");
    });

    it("round-trips unread counters", async () => {
        expect(await cache.getUnread("p3")).toEqual({});
        await cache.setUnread("p3", { s1: 3 });
        expect(await cache.getUnread("p3")).toEqual({ s1: 3 });
    });

    it("round-trips pinned sessions", async () => {
        expect(await cache.getPinned("p4")).toEqual([]);
        await cache.setPinned("p4", ["s1", "p2p:x"]);
        expect(await cache.getPinned("p4")).toEqual(["s1", "p2p:x"]);
        await cache.setPinned("p4", []);
        expect(await cache.getPinned("p4")).toEqual([]);
    });
});
