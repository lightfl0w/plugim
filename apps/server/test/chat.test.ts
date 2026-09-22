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
