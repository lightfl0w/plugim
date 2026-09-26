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

describe("p2p messaging", () => {
    it("only allows friends to chat", async () => {
        const app = await createTestApp();
        const ua = await app.register("pa");
        const ub = await app.register("pb");
        await expect(
            app.call(
                "message.send",
                { session: "p2p:pb", content: "hi" },
                ua.user,
            ),
        ).rejects.toThrow("只能和好友私聊");
        await app.call("friend.request", { username: "pb" }, ua.user);
        await app.call("friend.accept", { username: "pa" }, ub.user);
        const sent = (await app.call(
            "message.send",
            { session: "p2p:pb", content: "hi" },
            ua.user,
        )) as { session: string };
        expect(sent.session).toBe("p2p:pb");
    });

    it("delivers mirrored events to both sides", async () => {
        const { app, ua, ub } = await friendPair("qa", "qb");
        await app.call(
            "message.send",
            { session: "p2p:qb", content: "hello" },
            ua.user,
        );
        const mine = app.eventsFor(ua.user.id, "message:new");
        const theirs = app.eventsFor(ub.user.id, "message:new");
        const mineMsg = (
            mine[0] as { payload: { message: { session: string } } }
        ).payload.message;
        const theirsMsg = (
            theirs[0] as { payload: { message: { session: string } } }
        ).payload.message;
        expect(mineMsg.session).toBe("p2p:qb");
        expect(theirsMsg.session).toBe("p2p:qa");
    });

    it("keeps each friend's history isolated", async () => {
        const { app, ua, ub } = await friendPair("ha", "hb");
        const other = await app.register("hc");
        await app.call(
            "message.send",
            { session: "p2p:hb", content: "secret" },
            ua.user,
        );
        const history = (await app.call(
            "history.list",
            { session: "p2p:ha" },
            ub.user,
        )) as unknown[];
        expect(history).toHaveLength(1);
        await expect(
            app.call("history.list", { session: "p2p:hb" }, other.user),
        ).rejects.toThrow();
    });

    it("forwards a message to multiple sessions", async () => {
        const { app, ua } = await friendPair("fa", "fb");
        const fc = await app.register("fc");
        await app.call("friend.request", { username: "fc" }, ua.user);
        await app.call("friend.accept", { username: "fa" }, fc.user);
        const sent = (await app.call(
            "message.send",
            { session: "p2p:fb", content: "重要通知" },
            ua.user,
        )) as { id: string };
        const forwarded = (await app.call(
            "message.forward",
            { id: sent.id, sessions: ["p2p:fc", "general"] },
            ua.user,
        )) as { session: string; content: string; sender: string }[];
        expect(forwarded.map((m) => m.session)).toEqual(["p2p:fc", "general"]);
        expect(forwarded[0]).toMatchObject({
            content: "重要通知",
            sender: "fa",
        });
        const fcHistory = (await app.call(
            "history.list",
            { session: "p2p:fa" },
            fc.user,
        )) as unknown[];
        expect(fcHistory).toHaveLength(1);
    });

    it("merges multiple messages into one chat-record card", async () => {
        const { app, ua } = await friendPair("ma", "mb");
        const first = (await app.call(
            "message.send",
            { session: "p2p:mb", content: "第一条" },
            ua.user,
        )) as { id: string };
        const second = (await app.call(
            "message.send",
            { session: "p2p:mb", content: "第二条" },
            ua.user,
        )) as { id: string };
        const sent = (await app.call(
            "message.forward",
            {
                ids: [second.id, first.id],
                sessions: ["general"],
            },
            ua.user,
        )) as { content: string; kind: string }[];
        expect(sent).toHaveLength(1);
        expect(sent[0].kind).toBe("merge");
        const payload = JSON.parse(sent[0].content) as {
            merge: number;
            title: string;
            list: { content: string }[];
        };
        expect(payload.merge).toBe(1);
        expect(payload.title).toBe("2 条转发消息");
        expect(payload.list.map((m) => m.content)).toEqual([
            "第一条",
            "第二条",
        ]);
        await expect(
            app.call(
                "message.forward",
                { ids: [], sessions: ["general"] },
                ua.user,
            ),
        ).rejects.toThrow("请选择要转发的消息");
    });

    it("rejects forwarding messages the user cannot see", async () => {
        const { app, ua, ub } = await friendPair("va", "vb");
        const wc = await app.register("vc");
        await app.call("friend.request", { username: "vb" }, wc.user);
        await app.call("friend.accept", { username: "vc" }, ub.user);
        const privateMsg = (await app.call(
            "message.send",
            { session: "p2p:vb", content: "私下话" },
            wc.user,
        )) as { id: string };
        await expect(
            app.call(
                "message.forward",
                { id: privateMsg.id, sessions: ["general"] },
                ua.user,
            ),
        ).rejects.toThrow("无权转发");
    });

    it("validates forward targets and recalled source", async () => {
        const { app, ua } = await friendPair("wa", "wb");
        await expect(
            app.call(
                "message.forward",
                { id: "nope", sessions: ["general"] },
                ua.user,
            ),
        ).rejects.toThrow("消息不存在");
        const sent = (await app.call(
            "message.send",
            { session: "p2p:wb", content: "will recall" },
            ua.user,
        )) as { id: string };
        await expect(
            app.call("message.forward", { id: sent.id, sessions: [] }, ua.user),
        ).rejects.toThrow("请选择转发目标");
        await app.call("message.recall", { id: sent.id }, ua.user);
        await expect(
            app.call(
                "message.forward",
                { id: sent.id, sessions: ["p2p:wb"] },
                ua.user,
            ),
        ).rejects.toThrow("已撤回");
        const self = (await app.call(
            "message.send",
            { session: "p2p:wb", content: "copy me" },
            ua.user,
        )) as { id: string };
        await expect(
            app.call(
                "message.forward",
                { id: self.id, sessions: ["p2p:wa"] },
                ua.user,
            ),
        ).rejects.toThrow("没有有效的转发目标");
    });
});

describe("group messaging", () => {
    const makeGroup = async (ownerName = "ga", memberName = "gb") => {
        const app = await createTestApp();
        const owner = await app.register(ownerName);
        const member = await app.register(memberName);
        const group = (await app.call(
            "group.create",
            { name: "团队", members: [memberName] },
            owner.user,
        )) as { id: string };
        return { app, owner, member, group };
    };

    it("delivers to every member and stores under g: session", async () => {
        const { app, owner, member, group } = await makeGroup();
        await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "yo" },
            owner.user,
        );
        expect(app.eventsFor(member.user.id, "message:new").length).toBe(1);
        const history = (await app.call(
            "history.list",
            { session: `g:${group.id}` },
            member.user,
        )) as { content: string }[];
        expect(history[0].content).toBe("yo");
    });

    it("rejects non-members from sending and reading", async () => {
        const { app, group } = await makeGroup("na", "nb");
        const outsider = await app.register("nc");
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "x" },
                outsider.user,
            ),
        ).rejects.toThrow("不在该群");
        await expect(
            app.call(
                "history.list",
                { session: `g:${group.id}` },
                outsider.user,
            ),
        ).rejects.toThrow("不在该群");
    });

    it("enforces member mute and mute-all with admin exemption", async () => {
        const { app, owner, member, group } = await makeGroup("ma", "mb");
        await app.call(
            "group.member.mute",
            { groupId: group.id, username: "mb", muted: true },
            owner.user,
        );
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "x" },
                member.user,
            ),
        ).rejects.toThrow("禁言");
        await app.call(
            "group.member.mute",
            { groupId: group.id, username: "mb", muted: false },
            owner.user,
        );
        await app.call(
            "group.muteAll",
            { groupId: group.id, on: true },
            owner.user,
        );
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "x" },
                member.user,
            ),
        ).rejects.toThrow("全员禁言");
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "admin ok" },
                owner.user,
            ),
        ).resolves.toBeTruthy();
    });

    it("lets admins recall other members' messages", async () => {
        const { app, owner, member, group } = await makeGroup("ca", "cb");
        const sent = (await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "oops" },
            member.user,
        )) as { id: string };
        await expect(
            app.call("message.recall", { id: sent.id }, member.user),
        ).resolves.toBeTruthy();
        const second = (await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "oops2" },
            member.user,
        )) as { id: string };
        await expect(
            app.call("message.recall", { id: second.id }, owner.user),
        ).resolves.toBeTruthy();
    });

    it("passes quote and mentions through to storage", async () => {
        const { app, owner, group } = await makeGroup("ta", "tb");
        const sent = (await app.call(
            "message.send",
            {
                session: `g:${group.id}`,
                content: "hi @tb",
                quote: { sender: "tb", content: "before" },
                mentions: ["tb", "tb", 123 as unknown as string],
            },
            owner.user,
        )) as { quote: unknown; mentions: string[] };
        expect(sent.quote).toEqual({ sender: "tb", content: "before" });
        expect(sent.mentions).toEqual(["tb"]);
    });
});

describe("receipts", () => {
    it("records read cursor and notifies the peer", async () => {
        const { app, ua, ub } = await friendPair("ra", "rb");
        await app.call("receipt.read", { session: "p2p:ra" }, ub.user);
        const update = app.eventsFor(ua.user.id, "receipt:update");
        expect(update).toHaveLength(1);
        const rows = (await app.call(
            "receipt.list",
            { session: "p2p:rb" },
            ua.user,
        )) as { username: string }[];
        expect(rows.map((row) => row.username)).toContain("rb");
    });
});
