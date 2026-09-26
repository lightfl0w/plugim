import type { ScreenSignal } from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const pair = async () => {
    const app = await createTestApp();
    const a = await app.register("sa");
    const b = await app.register("sb");
    await app.call("friend.request", { username: "sb" }, a.user);
    await app.call("friend.accept", { username: "sa" }, b.user);
    app.setOnline(a.user);
    app.setOnline(b.user);
    return { app, a, b };
};

const inviteAndAccept = async (
    app: Awaited<ReturnType<typeof pair>>["app"],
    a: { user: { id: string; username: string } },
    b: { user: { id: string; username: string } },
) => {
    const { callId } = (await app.call(
        "screen.invite",
        { to: "sb" },
        a.user,
    )) as { callId: string };
    const invite = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
        payload: ScreenSignal;
    };
    expect(invite.payload).toMatchObject({ type: "invite", from: "sa" });
    app.setOnline(b.user);
    await app.call("screen.accept", { callId }, b.user);
    const accept = app.eventsFor(a.user.id, "screen:signal").at(-1) as {
        payload: ScreenSignal;
    };
    expect(accept.payload.type).toBe("accept");
    return callId;
};

describe("screen signaling", () => {
    it("returns ice server config", async () => {
        const { app, a } = await pair();
        const config = await app.call("screen.config", {}, a.user);
        expect(config).toEqual([{ urls: ["stun:stun.test:3478"] }]);
    });

    it("rejects invites to non-friends and offline users", async () => {
        const app = await createTestApp();
        const a = await app.register("na");
        const b = await app.register("nb");
        await expect(
            app.call("screen.invite", { to: "nb" }, a.user),
        ).rejects.toThrow("好友");
        await app.call("friend.request", { username: "nb" }, a.user);
        await app.call("friend.accept", { username: "na" }, b.user);
        await expect(
            app.call("screen.invite", { to: "nb" }, a.user),
        ).rejects.toThrow("不在线");
    });

    it("relays offer/answer/ice only after accept", async () => {
        const { app, a, b } = await pair();
        const callId = await inviteAndAccept(app, a, b);
        await app.call(
            "screen.signal",
            { callId, type: "offer", sdp: "v=0 fake" },
            a.user,
        );
        const offer = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(offer.payload).toMatchObject({
            type: "offer",
            from: "sa",
            sdp: "v=0 fake",
        });
        await app.call(
            "screen.signal",
            { callId, type: "ice", candidate: { candidate: "x" } },
            b.user,
        );
        const ice = app.eventsFor(a.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(ice.payload.type).toBe("ice");
        await expect(
            app.call(
                "screen.signal",
                { callId, type: "invite", sdp: "x" },
                a.user,
            ),
        ).rejects.toThrow("非法信令类型");
        await expect(
            app.call(
                "screen.signal",
                { callId, type: "offer", sdp: 123 as unknown as string },
                a.user,
            ),
        ).rejects.toThrow("缺少 SDP");
        await expect(
            app.call(
                "screen.signal",
                { callId: "other", type: "offer", sdp: "x" },
                a.user,
            ),
        ).rejects.toThrow("不存在");
    });

    it("blocks a second concurrent call for either party", async () => {
        const { app, a, b } = await pair();
        const c = await app.register("sc");
        for (const requester of [b.user, a.user]) {
            await app.call("friend.request", { username: "sc" }, requester);
            await app.call(
                "friend.accept",
                { username: requester.username },
                c.user,
            );
        }
        app.setOnline(c.user);
        const callId = await inviteAndAccept(app, a, b);
        await expect(
            app.call("screen.invite", { to: "sc" }, b.user),
        ).rejects.toThrow("正在进行");
        await expect(
            app.call("screen.invite", { to: "sb" }, a.user),
        ).rejects.toThrow("正在进行");
        await app.call("screen.hangup", { callId }, a.user);
        await app.call("screen.invite", { to: "sc" }, b.user);
        await expect(
            app.call("screen.invite", { to: "sc" }, a.user),
        ).rejects.toThrow("正忙");
    });

    it("decline and hangup tear the call down", async () => {
        const app = await createTestApp();
        const a = await app.register("da");
        const b = await app.register("db");
        await app.call("friend.request", { username: "db" }, a.user);
        await app.call("friend.accept", { username: "da" }, b.user);
        app.setOnline(a.user);
        app.setOnline(b.user);
        const { callId } = (await app.call(
            "screen.invite",
            { to: "db" },
            a.user,
        )) as { callId: string };
        await app.call("screen.decline", { callId }, b.user);
        const decline = app.eventsFor(a.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(decline.payload.type).toBe("decline");
        await expect(
            app.call("screen.accept", { callId }, b.user),
        ).rejects.toThrow("不存在");

        app.setOnline(b.user);
        const second = (await app.call(
            "screen.invite",
            { to: "db" },
            a.user,
        )) as { callId: string };
        await app.call("screen.accept", { callId: second.callId }, b.user);
        await app.call("screen.hangup", { callId: second.callId }, a.user);
        const hangup = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(hangup.payload.type).toBe("hangup");
        await expect(
            app.call(
                "screen.signal",
                { callId: second.callId, type: "ice", candidate: {} },
                a.user,
            ),
        ).rejects.toThrow("不存在");
    });

    it("rejects signal relay from strangers", async () => {
        const { app, a, b } = await pair();
        const callId = await inviteAndAccept(app, a, b);
        const intruder = await app.register("dx");
        app.setOnline(intruder.user);
        await expect(
            app.call(
                "screen.signal",
                { callId, type: "offer", sdp: "x" },
                intruder.user,
            ),
        ).rejects.toThrow("无权");
    });

    it("carries voice kind through invite and relay", async () => {
        const { app, a, b } = await pair();
        const result = (await app.call(
            "screen.invite",
            { to: "sb", kind: "voice" },
            a.user,
        )) as { callId: string; kind: string };
        expect(result.kind).toBe("voice");
        const invite = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(invite.payload).toMatchObject({
            type: "invite",
            kind: "voice",
        });
        await app.call("screen.accept", { callId: result.callId }, b.user);
        await app.call(
            "screen.signal",
            { callId: result.callId, type: "offer", sdp: "v=0 voice" },
            a.user,
        );
        const offer = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(offer.payload).toMatchObject({
            type: "offer",
            kind: "voice",
            sdp: "v=0 voice",
        });
    });

    it("voice call blocks a concurrent screen invite", async () => {
        const { app, a } = await pair();
        const { callId } = (await app.call(
            "screen.invite",
            { to: "sb", kind: "voice" },
            a.user,
        )) as { callId: string };
        await expect(
            app.call("screen.invite", { to: "sb" }, a.user),
        ).rejects.toThrow("正在进行");
        await app.call("screen.hangup", { callId }, a.user);
        await app.call("screen.invite", { to: "sb" }, a.user);
    });

    it("carries video kind through invite and relay", async () => {
        const { app, a, b } = await pair();
        const result = (await app.call(
            "screen.invite",
            { to: "sb", kind: "video" },
            a.user,
        )) as { callId: string; kind: string };
        expect(result.kind).toBe("video");
        const invite = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(invite.payload).toMatchObject({
            type: "invite",
            kind: "video",
        });
        await app.call("screen.accept", { callId: result.callId }, b.user);
        await app.call(
            "screen.signal",
            { callId: result.callId, type: "offer", sdp: "v=0 video" },
            a.user,
        );
        const offer = app.eventsFor(b.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(offer.payload).toMatchObject({
            type: "offer",
            kind: "video",
            sdp: "v=0 video",
        });
        await expect(
            app.call("screen.invite", { to: "sb", kind: "voice" }, a.user),
        ).rejects.toThrow("正在进行");
    });

    it("drops the call and notifies peer when a user disconnects", async () => {
        const { app, a, b } = await pair();
        const callId = await inviteAndAccept(app, a, b);
        app.goOffline(b.user.id);
        const hangup = app.eventsFor(a.user.id, "screen:signal").at(-1) as {
            payload: ScreenSignal;
        };
        expect(hangup.payload).toMatchObject({
            type: "hangup",
            callId,
            from: "sb",
        });
        await expect(
            app.call(
                "screen.signal",
                { callId, type: "ice", candidate: {} },
                a.user,
            ),
        ).rejects.toThrow("不存在");
        app.setOnline(b.user);
        await app.call("screen.invite", { to: "sb" }, a.user);
    });
});
