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

const listOf = async (
    app: Awaited<ReturnType<typeof createTestApp>>,
    user: { id: string },
) =>
    (await app.call("friend.list", {}, user as never)) as {
        friends: string[];
        remarks: Record<string, string>;
    };

describe("friend remarks", () => {
    it("sets, overwrites and clears a remark", async () => {
        const { app, ua } = await friendPair("aa", "ab");
        const set = (await app.call(
            "friend.remark",
            { username: "ab", remark: "  老同桌  " },
            ua.user,
        )) as { remarks: Record<string, string> };
        expect(set.remarks).toEqual({ ab: "老同桌" });
        await app.call(
            "friend.remark",
            { username: "ab", remark: "甲方" },
            ua.user,
        );
        expect((await listOf(app, ua.user)).remarks).toEqual({ ab: "甲方" });
        await app.call(
            "friend.remark",
            { username: "ab", remark: "  " },
            ua.user,
        );
        expect((await listOf(app, ua.user)).remarks).toEqual({});
    });

    it("keeps remarks private to their owner", async () => {
        const { app, ua, ub } = await friendPair("ba", "bb");
        await app.call(
            "friend.remark",
            { username: "bb", remark: "我给他的备注" },
            ua.user,
        );
        expect((await listOf(app, ub.user)).remarks).toEqual({});
        await app.call(
            "friend.remark",
            { username: "ba", remark: "他给我的备注" },
            ub.user,
        );
        expect((await listOf(app, ua.user)).remarks).toEqual({
            bb: "我给他的备注",
        });
    });

    it("rejects strangers, self and oversized remarks", async () => {
        const app = await createTestApp();
        const ua = await app.register("ca");
        await app.register("cb");
        await expect(
            app.call("friend.remark", { username: "cb", remark: "x" }, ua.user),
        ).rejects.toThrow("只能给好友设置备注");
        await expect(
            app.call("friend.remark", { username: "ca", remark: "x" }, ua.user),
        ).rejects.toThrow("不能给自己设置备注");
        const { app: paired, ua: pa } = await friendPair("da", "db");
        await expect(
            paired.call(
                "friend.remark",
                { username: "db", remark: "长".repeat(25) },
                pa.user,
            ),
        ).rejects.toThrow("不能超过 24 个字");
        await expect(
            paired.call("friend.remark", { username: "db", remark: "x" }, null),
        ).rejects.toThrow("未登录");
    });

    it("drops the remark from the list after unfriending and restores it on re-friending", async () => {
        const { app, ua, ub } = await friendPair("ea", "eb");
        await app.call(
            "friend.remark",
            { username: "eb", remark: "旧备注" },
            ua.user,
        );
        await app.call("friend.remove", { username: "eb" }, ua.user);
        const afterRemove = await listOf(app, ua.user);
        expect(afterRemove.friends).toEqual([]);
        expect(afterRemove.remarks).toEqual({});
        await app.call("friend.request", { username: "eb" }, ua.user);
        await app.call("friend.accept", { username: "ea" }, ub.user);
        expect((await listOf(app, ua.user)).remarks).toEqual({
            eb: "旧备注",
        });
    });
});
