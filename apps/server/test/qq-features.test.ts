import type { ChatMessage, GroupInfo, GroupMember } from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import type { TestApp } from "./helpers";
import { createTestApp } from "./helpers";

const friendPair = async (a: string, b: string) => {
    const app = await createTestApp();
    const ua = await app.register(a);
    const ub = await app.register(b);
    await app.call("friend.request", { username: b }, ua.user);
    await app.call("friend.accept", { username: a }, ub.user);
    return { app, ua, ub };
};

const presenceUpdates = (app: TestApp) =>
    app.events.filter((event) => event.name === "presence:update");

describe("presence status", () => {
    it("persists a status, broadcasts it and reports it in the list", async () => {
        const app = await createTestApp();
        const ua = await app.register("sa");
        const ub = await app.register("sb");
        app.setOnline(ua.user);
        app.setOnline(ub.user);
        const set = (await app.call(
            "presence.status.set",
            { status: "busy" },
            ua.user,
        )) as { status: string };
        expect(set.status).toBe("busy");
        const updates = presenceUpdates(app);
        expect(updates).toHaveLength(1);
        expect(updates[0].payload).toEqual({
            username: "sa",
            online: true,
            status: "busy",
        });
        expect(await app.call("presence.status", {}, ua.user)).toEqual({
            status: "busy",
        });
        const list = (await app.call("presence.list", {}, ub.user)) as {
            online: string[];
            statuses: Record<string, string>;
        };
        expect(list.online).toEqual(expect.arrayContaining(["sa", "sb"]));
        expect(list.statuses).toMatchObject({ sa: "busy", sb: "online" });
    });

    it("falls back to online for unknown values", async () => {
        const app = await createTestApp();
        const ua = await app.register("ta");
        const set = (await app.call(
            "presence.status.set",
            { status: "hacking" },
            ua.user,
        )) as { status: string };
        expect(set.status).toBe("online");
        await expect(
            app.call("presence.status.set", { status: "dnd" }, null),
        ).rejects.toThrow("未登录");
    });

    it("hides invisible users from the list and skips their broadcast", async () => {
        const app = await createTestApp();
        const ua = await app.register("ia");
        const ub = await app.register("ib");
        app.setOnline(ua.user);
        app.setOnline(ub.user);
        await app.call("presence.status.set", { status: "invisible" }, ua.user);
        expect(presenceUpdates(app)).toHaveLength(0);
        const list = (await app.call("presence.list", {}, ub.user)) as {
            online: string[];
            statuses: Record<string, string>;
        };
        expect(list.online).toEqual(["ib"]);
        expect(list.statuses).toEqual({ ib: "online" });
    });
});

describe("message reactions", () => {
    const send = async (
        app: TestApp,
        from: { user: { id: string } },
        session: string,
    ) =>
        (await app.call(
            "message.send",
            { session, content: "冲" },
            from.user as never,
        )) as ChatMessage;

    it("adds and toggles a reaction, notifying both sides per session", async () => {
        const { app, ua, ub } = await friendPair("ra", "rb");
        const sent = await send(app, ua, "p2p:rb");
        const first = (await app.call(
            "message.react",
            { id: sent.id, emoji: "👍" },
            ua.user,
        )) as { message: ChatMessage };
        expect(first.message.reactions).toEqual({ "👍": ["ra"] });
        const mine = app.eventsFor(ua.user.id, "message:update");
        const theirs = app.eventsFor(ub.user.id, "message:update");
        expect(mine).toHaveLength(1);
        expect(theirs).toHaveLength(1);
        expect(
            (mine[0] as { payload: { message: { session: string } } }).payload
                .message.session,
        ).toBe("p2p:rb");
        expect(
            (theirs[0] as { payload: { message: { session: string } } }).payload
                .message.session,
        ).toBe("p2p:ra");
        const history = (await app.call(
            "history.list",
            { session: "p2p:rb" },
            ua.user,
        )) as ChatMessage[];
        expect(history[0]?.reactions).toEqual({ "👍": ["ra"] });
        const toggled = (await app.call(
            "message.react",
            { id: sent.id, emoji: "👍" },
            ua.user,
        )) as { message: ChatMessage };
        expect(toggled.message.reactions).toBeNull();
    });

    it("stacks users on one emoji and removes one at a time", async () => {
        const { app, ua, ub } = await friendPair("ra2", "rb2");
        const sent = await send(app, ua, "p2p:rb2");
        await app.call("message.react", { id: sent.id, emoji: "❤️" }, ua.user);
        const both = (await app.call(
            "message.react",
            { id: sent.id, emoji: "❤️" },
            ub.user,
        )) as { message: ChatMessage };
        expect(both.message.reactions).toEqual({ "❤️": ["ra2", "rb2"] });
        const afterLeave = (await app.call(
            "message.react",
            { id: sent.id, emoji: "❤️" },
            ua.user,
        )) as { message: ChatMessage };
        expect(afterLeave.message.reactions).toEqual({ "❤️": ["rb2"] });
    });

    it("rejects invalid, missing, recalled and invisible targets", async () => {
        const { app, ua, ub } = await friendPair("va", "vb");
        const sent = await send(app, ua, "p2p:vb");
        const stranger = await app.register("vc");
        await expect(
            app.call("message.react", { id: sent.id, emoji: ":+" }, ua.user),
        ).rejects.toThrow("不支持的回应表情");
        await expect(
            app.call("message.react", { id: "missing", emoji: "👍" }, ua.user),
        ).rejects.toThrow("消息不存在");
        await expect(
            app.call(
                "message.react",
                { id: sent.id, emoji: "👍" },
                stranger.user,
            ),
        ).rejects.toThrow("无权回应该消息");
        await app.call("message.recall", { id: sent.id }, ua.user);
        await expect(
            app.call("message.react", { id: sent.id, emoji: "👍" }, ub.user),
        ).rejects.toThrow("消息已撤回");
        await expect(
            app.call("message.react", { id: sent.id, emoji: "👍" }, null),
        ).rejects.toThrow("未登录");
    });

    it("lets members react in groups and keeps strangers out", async () => {
        const app = await createTestApp();
        const owner = await app.register("ga1");
        const member = await app.register("ga2");
        const stranger = await app.register("ga3");
        const group = (await app.call(
            "group.create",
            { name: "回应群", members: ["ga2"] },
            owner.user,
        )) as GroupInfo;
        const sent = await send(app, owner, `g:${group.id}`);
        const reacted = (await app.call(
            "message.react",
            { id: sent.id, emoji: "🎉" },
            member.user,
        )) as { message: ChatMessage };
        expect(reacted.message.reactions).toEqual({ "🎉": ["ga2"] });
        await expect(
            app.call(
                "message.react",
                { id: sent.id, emoji: "🎉" },
                stranger.user,
            ),
        ).rejects.toThrow("无权回应该消息");
    });
});

describe("group member titles", () => {
    const membersOf = async (
        app: TestApp,
        groupId: string,
        user: { id: string },
    ) =>
        (
            (await app.call("group.members", { groupId }, user as never)) as {
                members: GroupMember[];
            }
        ).members;

    it("only the owner sets titles, trimmed to 12 chars and clearable", async () => {
        const app = await createTestApp();
        const owner = await app.register("ow1");
        const admin = await app.register("ad1");
        await app.register("me1");
        const group = (await app.call(
            "group.create",
            { name: "头衔群", members: ["ad1", "me1"] },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.member.role",
            { groupId: group.id, username: "ad1", role: "admin" },
            owner.user,
        );
        await expect(
            app.call(
                "group.member.title",
                { groupId: group.id, username: "me1", title: "队长" },
                admin.user,
            ),
        ).rejects.toThrow("只有群主可以设置头衔");
        await expect(
            app.call(
                "group.member.title",
                { groupId: group.id, username: "nobody", title: "队长" },
                owner.user,
            ),
        ).rejects.toThrow("用户不存在");
        await app.call(
            "group.member.title",
            { groupId: group.id, username: "me1", title: "  首席摸鱼官  " },
            owner.user,
        );
        expect(
            (await membersOf(app, group.id, owner.user)).find(
                (m) => m.username === "me1",
            )?.title,
        ).toBe("首席摸鱼官");
        await app.call(
            "group.member.title",
            { groupId: group.id, username: "me1", title: "长".repeat(15) },
            owner.user,
        );
        expect(
            (await membersOf(app, group.id, owner.user)).find(
                (m) => m.username === "me1",
            )?.title,
        ).toBe("长".repeat(12));
        await app.call(
            "group.member.title",
            { groupId: group.id, username: "me1", title: "  " },
            owner.user,
        );
        expect(
            (await membersOf(app, group.id, owner.user)).find(
                (m) => m.username === "me1",
            )?.title ?? null,
        ).toBeNull();
    });
});

describe("friend stars", () => {
    it("stars friends only and keeps stars private", async () => {
        const { app, ua, ub } = await friendPair("fa1", "fb1");
        await app.register("fc1");
        await expect(
            app.call("friend.star", { username: "fa1", on: true }, ua.user),
        ).rejects.toThrow("不能特别关心自己");
        await expect(
            app.call("friend.star", { username: "fc1", on: true }, ua.user),
        ).rejects.toThrow("只能特别关心好友");
        const starred = (await app.call(
            "friend.star",
            { username: "fb1", on: true },
            ua.user,
        )) as { starred: string[] };
        expect(starred.starred).toEqual(["fb1"]);
        const theirs = (await app.call("friend.list", {}, ub.user)) as {
            starred: string[];
        };
        expect(theirs.starred).toEqual([]);
        const unstarred = (await app.call(
            "friend.star",
            { username: "fb1", on: false },
            ua.user,
        )) as { starred: string[] };
        expect(unstarred.starred).toEqual([]);
        await expect(
            app.call("friend.star", { username: "fb1", on: true }, null),
        ).rejects.toThrow("未登录");
    });
});
