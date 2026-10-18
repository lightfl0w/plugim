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
        { name: "转账群", members: ["bob", "carol"] },
        asUser(alice.user),
    )) as { id: string };
    const topup = async (user: { id: string }, amount: number) => {
        await app.call("wallet.topup", { amount }, asUser(user));
    };
    return { app, alice, bob, carol, group, topup };
};

const balanceOf = async (
    app: Awaited<ReturnType<typeof createTestApp>>,
    user: { id: string },
) =>
    (
        (await app.call("wallet.balance", {}, asUser(user))) as {
            balance: number;
        }
    ).balance;

describe("transfer", () => {
    it("发起转账立即冻结余额，收款后到账", async () => {
        const { app, alice, bob, topup } = await setup();
        await topup(alice.user, 10000);
        const created = (await app.call(
            "transfer.send",
            {
                sessionId: "p2p:bob",
                toUsername: "bob",
                amount: 3000,
                message: "还你钱",
            },
            asUser(alice.user),
        )) as { transfer: { id: string; state: string } };
        expect(created.transfer.state).toBe("pending");
        expect(await balanceOf(app, alice.user)).toBe(7000);
        expect(await balanceOf(app, bob.user)).toBe(0);

        await app.call(
            "transfer.accept",
            { transferId: created.transfer.id },
            asUser(bob.user),
        );
        expect(await balanceOf(app, alice.user)).toBe(7000);
        expect(await balanceOf(app, bob.user)).toBe(3000);
    });

    it("拒绝转账会把金额退回发起人", async () => {
        const { app, alice, bob, topup } = await setup();
        await topup(alice.user, 5000);
        const created = (await app.call(
            "transfer.send",
            { sessionId: "p2p:bob", toUsername: "bob", amount: 1200 },
            asUser(alice.user),
        )) as { transfer: { id: string } };
        const settled = (await app.call(
            "transfer.reject",
            { transferId: created.transfer.id },
            asUser(bob.user),
        )) as { transfer: { state: string } };
        expect(settled.transfer.state).toBe("rejected");
        expect(await balanceOf(app, alice.user)).toBe(5000);
        expect(await balanceOf(app, bob.user)).toBe(0);
    });

    it("余额不足时拒绝发起", async () => {
        const { app, alice, topup } = await setup();
        await topup(alice.user, 100);
        await expect(
            app.call(
                "transfer.send",
                { sessionId: "p2p:bob", toUsername: "bob", amount: 5000 },
                asUser(alice.user),
            ),
        ).rejects.toThrow(/余额不足/);
    });

    it("非好友与非收款人无法操作", async () => {
        const { app, alice, topup } = await setup();
        await topup(alice.user, 9000);
        await expect(
            app.call(
                "transfer.send",
                {
                    sessionId: "p2p:carol",
                    toUsername: "carol",
                    amount: 100,
                },
                asUser(alice.user),
            ),
        ).resolves.toBeTruthy();

        const second = await app.register("dave");
        await expect(
            app.call(
                "transfer.send",
                {
                    sessionId: "p2p:dave",
                    toUsername: "dave",
                    amount: 100,
                },
                asUser(alice.user),
            ),
        ).rejects.toThrow(/好友/);

        const created = (await app.call(
            "transfer.send",
            {
                sessionId: "p2p:carol",
                toUsername: "carol",
                amount: 100,
            },
            asUser(alice.user),
        )) as { transfer: { id: string } };
        await expect(
            app.call(
                "transfer.accept",
                { transferId: created.transfer.id },
                asUser(second.user),
            ),
        ).rejects.toThrow(/收款人/);
    });

    it("同一笔转账不能被重复处理", async () => {
        const { app, alice, bob, topup } = await setup();
        await topup(alice.user, 4000);
        const created = (await app.call(
            "transfer.send",
            { sessionId: "p2p:bob", toUsername: "bob", amount: 800 },
            asUser(alice.user),
        )) as { transfer: { id: string } };
        await app.call(
            "transfer.accept",
            { transferId: created.transfer.id },
            asUser(bob.user),
        );
        await expect(
            app.call(
                "transfer.accept",
                { transferId: created.transfer.id },
                asUser(bob.user),
            ),
        ).rejects.toThrow(/处理过/);
        expect(await balanceOf(app, bob.user)).toBe(800);
    });

    it("转账消息落库并可回读", async () => {
        const { app, alice, bob, topup } = await setup();
        await topup(alice.user, 2000);
        const created = (await app.call(
            "transfer.send",
            {
                sessionId: "p2p:bob",
                toUsername: "bob",
                amount: 600,
                message: "午饭",
            },
            asUser(alice.user),
        )) as {
            transfer: { id: string };
            message: { id: string; kind: string };
        };
        expect(created.message.kind).toBe("transfer");
        const history = (await app.call(
            "history.list",
            { session: "p2p:alice", limit: 20 },
            asUser(bob.user),
        )) as {
            id: string;
            kind: string;
            transfer?: { id: string; amount: number };
        }[];
        const found = history.find((m) => m.id === created.message.id);
        expect(found?.kind).toBe("transfer");
        expect(found?.transfer?.amount).toBe(600);
    });

    it("不能给自己转账，也不能在群里转账", async () => {
        const { app, alice, group, topup } = await setup();
        await topup(alice.user, 3000);
        await expect(
            app.call(
                "transfer.send",
                {
                    sessionId: "p2p:alice",
                    toUsername: "alice",
                    amount: 100,
                },
                asUser(alice.user),
            ),
        ).rejects.toThrow(/自己/);
        await expect(
            app.call(
                "transfer.send",
                {
                    sessionId: `g:${group.id}`,
                    toUsername: "bob",
                    amount: 100,
                },
                asUser(alice.user),
            ),
        ).rejects.toThrow(/私聊/);
    });
});

describe("aa", () => {
    it("均分账单：付款后金额从付款人转到发起人，全额付清自动结清", async () => {
        const { app, alice, bob, carol, group, topup } = await setup();
        await topup(bob.user, 10000);
        await topup(carol.user, 10000);
        const created = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "聚餐",
                totalAmount: 900,
                splitType: "equal",
            },
            asUser(alice.user),
        )) as { bill: { id: string; participantIds: string[] } };
        expect(created.bill.participantIds).toHaveLength(2);

        const bobShare = Math.floor(900 / 2);
        const carolShare = 900 - bobShare;
        await app.call(
            "aa.pay",
            { billId: created.bill.id, amount: bobShare },
            asUser(bob.user),
        );
        expect(await balanceOf(app, alice.user)).toBe(bobShare);
        expect(await balanceOf(app, bob.user)).toBe(10000 - bobShare);

        await app.call(
            "aa.pay",
            { billId: created.bill.id, amount: carolShare },
            asUser(carol.user),
        );
        expect(await balanceOf(app, alice.user)).toBe(900);
        const detail = (await app.call(
            "aa.detail",
            { billId: created.bill.id },
            asUser(bob.user),
        )) as {
            bill: { status: string; settledAmount: number };
            members: { userId: string; share: number; paid: boolean }[];
        };
        expect(detail.bill.status).toBe("settled");
        expect(detail.bill.settledAmount).toBe(900);
        expect(detail.members.every((m) => m.paid)).toBe(true);
        expect(detail.members.reduce((sum, m) => sum + m.share, 0)).toBe(900);
    });

    it("自定义分摊必须守恒，否则创建失败", async () => {
        const { app, alice, group } = await setup();
        await expect(
            app.call(
                "aa.create",
                {
                    sessionId: `g:${group.id}`,
                    description: "乱分",
                    totalAmount: 1000,
                    splitType: "custom",
                    customSplits: {},
                },
                asUser(alice.user),
            ),
        ).rejects.toThrow(/分摊/);

        const ids = (await app.call(
            "aa.candidates",
            { sessionId: `g:${group.id}` },
            asUser(alice.user),
        )) as { candidates: { userId: string; username: string }[] };
        const bobId = ids.candidates.find((c) => c.username === "bob")
            ?.userId as string;
        const carolId = ids.candidates.find((c) => c.username === "carol")
            ?.userId as string;
        const ok = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "自定义",
                totalAmount: 1000,
                splitType: "custom",
                customSplits: { [bobId]: 700, [carolId]: 300 },
            },
            asUser(alice.user),
        )) as { bill: { customSplits: Record<string, number> } };
        expect(
            Object.values(ok.bill.customSplits).reduce((a, b) => a + b, 0),
        ).toBe(1000);
    });

    it("不能重复付款，金额必须等于自己的分摊", async () => {
        const { app, alice, bob, group, topup } = await setup();
        await topup(bob.user, 5000);
        const created = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "双人",
                totalAmount: 1000,
                splitType: "equal",
            },
            asUser(alice.user),
        )) as { bill: { id: string } };
        await expect(
            app.call(
                "aa.pay",
                { billId: created.bill.id, amount: 1 },
                asUser(bob.user),
            ),
        ).rejects.toThrow(/不一致/);
        await app.call(
            "aa.pay",
            { billId: created.bill.id, amount: 500 },
            asUser(bob.user),
        );
        await expect(
            app.call(
                "aa.pay",
                { billId: created.bill.id, amount: 500 },
                asUser(bob.user),
            ),
        ).rejects.toThrow(/付过/);
        expect(await balanceOf(app, bob.user)).toBe(4500);
    });

    it("余额不足时无法支付", async () => {
        const { app, alice, bob, group } = await setup();
        const created = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "没钱",
                totalAmount: 1000,
                splitType: "equal",
            },
            asUser(alice.user),
        )) as { bill: { id: string } };
        await expect(
            app.call(
                "aa.pay",
                { billId: created.bill.id, amount: 500 },
                asUser(bob.user),
            ),
        ).rejects.toThrow(/余额不足/);
    });

    it("非发起人不能取消，发起人可取消未结清的账单", async () => {
        const { app, alice, bob, group } = await setup();
        const created = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "待取消",
                totalAmount: 600,
                splitType: "equal",
            },
            asUser(alice.user),
        )) as { bill: { id: string } };
        await expect(
            app.call(
                "aa.cancel",
                { billId: created.bill.id },
                asUser(bob.user),
            ),
        ).rejects.toThrow(/发起人/);
        const canceled = (await app.call(
            "aa.cancel",
            { billId: created.bill.id },
            asUser(alice.user),
        )) as { detail: { bill: { status: string } } };
        expect(canceled.detail.bill.status).toBe("cancelled");
    });

    it("群外成员无权查看账单", async () => {
        const { app, alice, group } = await setup();
        const outsider = await app.register("outsider");
        const created = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "私密",
                totalAmount: 300,
                splitType: "equal",
            },
            asUser(alice.user),
        )) as { bill: { id: string } };
        await expect(
            app.call(
                "aa.detail",
                { billId: created.bill.id },
                asUser(outsider.user),
            ),
        ).rejects.toThrow(/无权/);
    });

    it("账单消息落库并可回读", async () => {
        const { app, alice, group } = await setup();
        const created = (await app.call(
            "aa.create",
            {
                sessionId: `g:${group.id}`,
                description: "落库",
                totalAmount: 300,
                splitType: "equal",
            },
            asUser(alice.user),
        )) as {
            bill: { id: string };
            message: { id: string; kind: string };
        };
        expect(created.message.kind).toBe("aabill");
        const history = (await app.call(
            "history.list",
            { session: `g:${group.id}`, limit: 20 },
            asUser(alice.user),
        )) as {
            id: string;
            kind: string;
            aaBill?: { id: string; totalAmount: number };
        }[];
        const found = history.find((m) => m.id === created.message.id);
        expect(found?.kind).toBe("aabill");
        expect(found?.aaBill?.id).toBe(created.bill.id);
    });
});
