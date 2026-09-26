import { beforeEach, describe, expect, it, vi } from "vitest";

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock("web-push", () => ({
    default: {
        generateVAPIDKeys: () => ({
            publicKey: "test-public-key",
            privateKey: "test-private-key",
        }),
        setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
        sendNotification: (...args: unknown[]) => sendNotification(...args),
    },
}));

const { createTestApp } = await import("./helpers");

const friendPair = async (a: string, b: string) => {
    const app = await createTestApp();
    const ua = await app.register(a);
    const ub = await app.register(b);
    await app.call("friend.request", { username: b }, ua.user);
    await app.call("friend.accept", { username: a }, ub.user);
    return { app, ua, ub };
};

const subscription = (endpoint: string) => ({
    subscription: {
        endpoint,
        keys: { p256dh: "p256dh-value", auth: "auth-value" },
    },
});

describe("push subscriptions", () => {
    beforeEach(() => {
        sendNotification.mockReset();
        sendNotification.mockResolvedValue({ statusCode: 201 });
    });

    it("publishes generated vapid keys and manages subscriptions", async () => {
        const app = await createTestApp();
        const a = await app.register("wa");
        const info = (await app.call("push.info", {}, a.user)) as {
            publicKey: string;
            subscriptions: number;
        };
        expect(info.publicKey).toBe("test-public-key");
        expect(info.subscriptions).toBe(0);
        expect(setVapidDetails).toHaveBeenCalled();
        const after = (await app.call(
            "push.subscribe",
            subscription("https://push.test/one"),
            a.user,
        )) as { subscriptions: number };
        expect(after.subscriptions).toBe(1);
        await app.call(
            "push.subscribe",
            subscription("https://push.test/one"),
            a.user,
        );
        const again = (await app.call("push.info", {}, a.user)) as {
            subscriptions: number;
        };
        expect(again.subscriptions).toBe(1);
        const removed = (await app.call(
            "push.unsubscribe",
            { endpoint: "https://push.test/one" },
            a.user,
        )) as { subscriptions: number };
        expect(removed.subscriptions).toBe(0);
    });

    it("rejects incomplete subscriptions and sends a test notification", async () => {
        const app = await createTestApp();
        const a = await app.register("wb");
        await expect(
            app.call("push.subscribe", { subscription: {} }, a.user),
        ).rejects.toThrow("订阅信息不完整");
        await expect(app.call("push.test", {}, a.user)).rejects.toThrow(
            "当前设备未开启推送",
        );
        await app.call(
            "push.subscribe",
            subscription("https://push.test/wb"),
            a.user,
        );
        await expect(app.call("push.test", {}, a.user)).resolves.toEqual({
            ok: true,
        });
        expect(sendNotification).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(
            String(sendNotification.mock.calls[0][1]),
        ) as { title: string };
        expect(payload.title).toBe("plugim");
    });
});

describe("offline delivery", () => {
    beforeEach(() => {
        sendNotification.mockReset();
        sendNotification.mockResolvedValue({ statusCode: 201 });
    });

    it("pushes only to offline recipients", async () => {
        const { app, ua, ub } = await friendPair("pa2", "pb2");
        await app.call(
            "push.subscribe",
            subscription("https://push.test/pb2"),
            ub.user,
        );
        app.setOnline(ub.user);
        await app.call(
            "message.send",
            { session: "p2p:pb2", content: "online" },
            ua.user,
        );
        await app.call(
            "message.send",
            { session: "p2p:pb2", content: "still online" },
            ua.user,
        );
        expect(sendNotification).not.toHaveBeenCalled();
        app.goOffline(ub.user.id);
        await app.call(
            "message.send",
            { session: "p2p:pb2", content: "offline now" },
            ua.user,
        );
        await vi.waitFor(() =>
            expect(sendNotification).toHaveBeenCalledTimes(1),
        );
        const payload = JSON.parse(
            String(sendNotification.mock.calls[0][1]),
        ) as { title: string; body: string; session: string };
        expect(payload.title).toBe("pa2");
        expect(payload.body).toBe("offline now");
        expect(payload.session).toBe("p2p:pa2");
    });

    it("drops subscriptions that the push service reports gone", async () => {
        const { app, ua, ub } = await friendPair("pc2", "pd2");
        await app.call(
            "push.subscribe",
            subscription("https://push.test/pd2"),
            ub.user,
        );
        sendNotification.mockRejectedValueOnce({ statusCode: 410 });
        await app.call(
            "message.send",
            { session: "p2p:pd2", content: "first" },
            ua.user,
        );
        await vi.waitFor(async () => {
            const info = (await app.call("push.info", {}, ub.user)) as {
                subscriptions: number;
            };
            expect(info.subscriptions).toBe(0);
        });
        await app.call(
            "message.send",
            { session: "p2p:pd2", content: "second" },
            ua.user,
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sendNotification).toHaveBeenCalledTimes(1);
    });
});

describe("group delivery", () => {
    it("skips the sender and pushes group members", async () => {
        sendNotification.mockReset();
        sendNotification.mockResolvedValue({ statusCode: 201 });
        const app = await createTestApp();
        const owner = await app.register("pg1");
        const member = await app.register("pg2");
        const group = (await app.call(
            "group.create",
            { name: "推送群", members: ["pg2"] },
            owner.user,
        )) as { id: string };
        await app.call(
            "push.subscribe",
            subscription("https://push.test/pg2"),
            member.user,
        );
        await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "群消息" },
            owner.user,
        );
        await vi.waitFor(() =>
            expect(sendNotification).toHaveBeenCalledTimes(1),
        );
        const payload = JSON.parse(
            String(sendNotification.mock.calls[0][1]),
        ) as { title: string; body: string };
        expect(payload.title).toBe("推送群");
        expect(payload.body).toBe("pg1: 群消息");
    });
});
