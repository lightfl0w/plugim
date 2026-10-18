import { describe, expect, it } from "vitest";
import { asUser, createTestApp } from "./helpers";

const setup = async () => {
    const app = await createTestApp();
    const alice = await app.register("alice");
    const bob = await app.register("bob");
    const carol = await app.register("carol");
    await app.call("friend.request", { username: "bob" }, asUser(alice.user));
    await app.call("friend.accept", { username: "alice" }, asUser(bob.user));
    await app.call("friend.request", { username: "carol" }, asUser(alice.user));
    await app.call("friend.accept", { username: "alice" }, asUser(carol.user));
    const group = (await app.call(
        "group.create",
        { name: "红包群", members: ["bob", "carol"] },
        asUser(alice.user),
    )) as { id: string };
    return { app, alice, bob, carol, group };
};

describe("redpacket", () => {
    it("普通红包均分，每人金额相同且总额守恒", async () => {
        const { app, alice, bob, carol, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 900,
                totalCount: 2,
                message: "均分红包",
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        const id = created.packet.id;

        const first = (await app.call(
            "redpacket.claim",
            { redPacketId: id },
            asUser(bob.user),
        )) as { amount: number };
        const second = (await app.call(
            "redpacket.claim",
            { redPacketId: id },
            asUser(carol.user),
        )) as { amount: number };
        expect(first.amount).toBe(450);
        expect(second.amount).toBe(450);

        const detail = (await app.call(
            "redpacket.detail",
            { redPacketId: id },
            asUser(bob.user),
        )) as {
            packet: {
                status: string;
                remaining: number;
                remainCount: number;
                claimedCount: number;
                myAmount: number;
            };
        };
        expect(detail.packet.status).toBe("exhausted");
        expect(detail.packet.remaining).toBe(0);
        expect(detail.packet.remainCount).toBe(0);
        expect(detail.packet.claimedCount).toBe(2);
        expect(detail.packet.myAmount).toBe(450);
    });

    it("不能重复领取同一个红包", async () => {
        const { app, alice, bob, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 500,
                totalCount: 2,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        await app.call(
            "redpacket.claim",
            { redPacketId: created.packet.id },
            asUser(bob.user),
        );
        await expect(
            app.call(
                "redpacket.claim",
                { redPacketId: created.packet.id },
                asUser(bob.user),
            ),
        ).rejects.toThrow("你已经领过这个红包了");
    });

    it("不能领取自己发的红包", async () => {
        const { app, alice, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 100,
                totalCount: 1,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        await expect(
            app.call(
                "redpacket.claim",
                { redPacketId: created.packet.id },
                asUser(alice.user),
            ),
        ).rejects.toThrow("不能领取自己发的红包");
    });

    it("并发领取不超发，总额守恒", async () => {
        const { app, alice, bob, carol, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 1000,
                totalCount: 5,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        const id = created.packet.id;

        const results = await Promise.allSettled([
            app.call("redpacket.claim", { redPacketId: id }, asUser(bob.user)),
            app.call(
                "redpacket.claim",
                { redPacketId: id },
                asUser(carol.user),
            ),
            app.call("redpacket.claim", { redPacketId: id }, asUser(bob.user)),
        ]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const amounts = ok.map(
            (r) =>
                (r as PromiseFulfilledResult<{ amount: number }>).value.amount,
        );
        expect(amounts.length).toBeGreaterThan(0);
        expect(amounts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);

        const detail = (await app.call(
            "redpacket.detail",
            { redPacketId: id },
            asUser(alice.user),
        )) as { packet: { remaining: number } };
        expect(detail.packet.remaining).toBe(
            1000 - amounts.reduce((a, b) => a + b, 0),
        );
    });

    it("拼手气红包金额随机且总额守恒", async () => {
        const { app, alice, bob, carol, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "lucky",
                totalAmount: 1000,
                totalCount: 3,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        const id = created.packet.id;
        const dave = await app.register("dave");
        await app.call(
            "friend.request",
            { username: "dave" },
            asUser(alice.user),
        );
        await app.call(
            "friend.accept",
            { username: "alice" },
            asUser(dave.user),
        );
        await app.call(
            "group.member.add",
            { groupId: group.id, usernames: ["dave"] },
            asUser(alice.user),
        );
        const got: number[] = [];
        for (const user of [bob, carol, dave]) {
            const res = (await app.call(
                "redpacket.claim",
                { redPacketId: id },
                asUser(user.user),
            )) as { amount: number };
            got.push(res.amount);
        }
        expect(got.reduce((a, b) => a + b, 0)).toBe(1000);
        expect(Math.min(...got)).toBeGreaterThanOrEqual(1);
        expect(got).not.toEqual([333, 333, 334]);
    });

    it("红包数量用尽后无法继续领取", async () => {
        const { app, alice, bob, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 100,
                totalCount: 1,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        const id = created.packet.id;
        await app.call(
            "redpacket.claim",
            { redPacketId: id },
            asUser(bob.user),
        );
        await expect(
            app.call("redpacket.claim", { redPacketId: id }, asUser(bob.user)),
        ).rejects.toThrow();
    });

    it("非会话成员不能领取", async () => {
        const { app, alice, group } = await setup();
        const outsider = await app.register("dave");
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 100,
                totalCount: 2,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        await expect(
            app.call(
                "redpacket.claim",
                { redPacketId: created.packet.id },
                asUser(outsider.user),
            ),
        ).rejects.toThrow("你不在该会话中");
    });

    it("私聊红包仅对方可见可领", async () => {
        const { app, alice, bob, carol } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: "p2p:bob",
                type: "normal",
                totalAmount: 200,
                totalCount: 2,
            },
            asUser(alice.user),
        )) as { packet: { id: string; sessionId: string } };
        expect(created.packet.sessionId.startsWith("p2p:")).toBe(true);
        await expect(
            app.call(
                "redpacket.claim",
                { redPacketId: created.packet.id },
                asUser(carol.user),
            ),
        ).rejects.toThrow("你不在该会话中");
        const res = (await app.call(
            "redpacket.claim",
            { redPacketId: created.packet.id },
            asUser(bob.user),
        )) as { amount: number };
        expect(res.amount).toBe(100);
    });

    it("领取后广播红包状态变更", async () => {
        const { app, alice, bob, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 300,
                totalCount: 3,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        const id = created.packet.id;
        app.events.length = 0;
        await app.call(
            "redpacket.claim",
            { redPacketId: id },
            asUser(bob.user),
        );
        const updates = app.eventsFor(bob.user.id, "redpacket:update");
        expect(updates.length).toBeGreaterThan(0);
        const payload = updates[0].payload as {
            id: string;
            remainCount: number;
        };
        expect(payload.id).toBe(id);
        expect(payload.remainCount).toBe(2);
    });

    it("红包消息以 redpacket 类型落库并广播", async () => {
        const { app, alice, bob, group } = await setup();
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 100,
                totalCount: 1,
                message: "手气最佳",
            },
            asUser(alice.user),
        )) as {
            message: { kind: string; content: string };
            packet: { id: string };
        };
        expect(created.message.kind).toBe("redpacket");
        expect(created.message.content).toBe("手气最佳");
        const news = app.eventsFor(bob.user.id, "message:new");
        expect(news.length).toBeGreaterThan(0);
        const payload = news[news.length - 1].payload as {
            message: { redPacket?: { id: string } | null };
        };
        expect(payload.message.redPacket?.id).toBe(created.packet.id);

        const history = (await app.call(
            "history.list",
            { session: `g:${group.id}`, limit: 10 },
            asUser(bob.user),
        )) as { kind: string; redPacket?: { id: string } | null }[];
        const restored = history.find((m) => m.kind === "redpacket");
        expect(restored?.redPacket?.id).toBe(created.packet.id);
    });

    it("非法参数被拒绝", async () => {
        const { app, alice, group } = await setup();
        const send = (params: Record<string, unknown>) =>
            app.call(
                "redpacket.create",
                {
                    sessionId: `g:${group.id}`,
                    type: "normal",
                    totalAmount: 100,
                    totalCount: 1,
                    ...params,
                },
                asUser(alice.user),
            );
        await expect(send({ totalAmount: 0 })).rejects.toThrow(
            "红包金额必须大于 0",
        );
        await expect(send({ totalAmount: -5 })).rejects.toThrow(
            "红包金额必须大于 0",
        );
        await expect(send({ totalAmount: 1.5 })).rejects.toThrow("整数");
        await expect(send({ totalCount: 0 })).rejects.toThrow(
            "红包个数必须大于 0",
        );
        await expect(send({ totalCount: 999 })).rejects.toThrow(
            "红包个数不能超过",
        );
        await expect(send({ totalAmount: 5, totalCount: 10 })).rejects.toThrow(
            "金额不足以拆分成这么多个红包",
        );
        await expect(
            app.call(
                "redpacket.create",
                {
                    sessionId: config_defaultSession(),
                    type: "normal",
                    totalAmount: 100,
                    totalCount: 1,
                },
                asUser(alice.user),
            ),
        ).rejects.toThrow("红包只能在私聊或群聊中发送");
    });

    it("不能给自己发红包", async () => {
        const { app, alice } = await setup();
        await expect(
            app.call(
                "redpacket.create",
                {
                    sessionId: "p2p:alice",
                    type: "normal",
                    totalAmount: 100,
                    totalCount: 1,
                },
                asUser(alice.user),
            ),
        ).rejects.toThrow("不能给自己发红包");
    });

    it("领取记录带用户名与备注", async () => {
        const { app, alice, bob, group } = await setup();
        await app.call(
            "friend.remark",
            { username: "bob", remark: "老王" },
            asUser(alice.user),
        );
        const created = (await app.call(
            "redpacket.create",
            {
                sessionId: `g:${group.id}`,
                type: "normal",
                totalAmount: 100,
                totalCount: 1,
            },
            asUser(alice.user),
        )) as { packet: { id: string } };
        await app.call(
            "redpacket.claim",
            { redPacketId: created.packet.id },
            asUser(bob.user),
        );
        const records = (await app.call(
            "redpacket.records",
            { redPacketId: created.packet.id },
            asUser(alice.user),
        )) as { username: string; amount: number }[];
        expect(records[0].username).toBe("老王");
        expect(records[0].amount).toBe(100);
    });
});

const config_defaultSession = () => "general";
