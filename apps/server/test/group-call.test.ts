import type { GroupCallEvent, GroupCallSignal } from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

type App = Awaited<ReturnType<typeof createTestApp>>;

const setup = async (members: string[] = ["adm", "mem"]) => {
    const app = await createTestApp();
    const owner = await app.register("own");
    const invited: { user: { id: string; username: string }; token: string }[] =
        [];
    for (const name of members) invited.push(await app.register(name));
    const stranger = await app.register("str");
    const group = (await app.call(
        "group.create",
        { name: "作战群", members },
        owner.user,
    )) as { id: string };
    return { app, owner, invited, stranger, group };
};

const lastEvent = (app: App, userId: string) =>
    app.eventsFor(userId, "group:call").at(-1)?.payload as GroupCallEvent;

const start = async (
    app: App,
    owner: { user: { id: string } },
    groupId: string,
    kind = "voice",
) =>
    (await app.call("call.group.start", { groupId, kind }, owner.user)) as {
        roomId: string;
        groupId: string;
        groupName: string;
        kind: string;
        host: string;
        members: string[];
    };

describe("group call signaling", () => {
    it("starts a room and invites the other members", async () => {
        const { app, owner, invited, group } = await setup();
        const room = await start(app, owner, group.id);
        expect(room).toMatchObject({
            groupId: group.id,
            groupName: "作战群",
            kind: "voice",
            host: "own",
            members: ["own"],
        });
        for (const member of invited)
            expect(lastEvent(app, member.user.id)).toMatchObject({
                type: "invite",
                roomId: room.roomId,
                groupId: group.id,
                groupName: "作战群",
                kind: "voice",
                from: "own",
            });
        expect(app.eventsFor(owner.user.id, "group:call")).toHaveLength(0);
        const info = await app.call(
            "call.group.info",
            { groupId: group.id },
            invited[0].user,
        );
        expect(info).toMatchObject({ roomId: room.roomId, members: ["own"] });
        const idle = (await app.call(
            "group.create",
            { name: "空闲群" },
            owner.user,
        )) as { id: string };
        expect(
            await app.call("call.group.info", { groupId: idle.id }, owner.user),
        ).toBeNull();
        await expect(
            app.call("call.group.info", { groupId: "nope" }, owner.user),
        ).rejects.toThrow("群组不存在");
    });

    it("relays signals between room members only", async () => {
        const { app, owner, invited, stranger, group } = await setup();
        const room = await start(app, owner, group.id, "video");
        await expect(
            app.call("call.group.join", { roomId: room.roomId }, stranger.user),
        ).rejects.toThrow("不在该群");
        const joined = (await app.call(
            "call.group.join",
            { roomId: room.roomId },
            invited[0].user,
        )) as { room: { members: string[] }; others: string[] };
        expect(joined.others).toEqual(["own"]);
        expect(joined.room.members).toEqual(["own", "adm"]);
        expect(lastEvent(app, owner.user.id)).toMatchObject({
            type: "join",
            from: "adm",
        });
        await app.call(
            "call.group.signal",
            { roomId: room.roomId, to: "own", type: "offer", sdp: "v=0 adm" },
            invited[0].user,
        );
        const offer = app.eventsFor(owner.user.id, "group:call:signal").at(-1)
            ?.payload as GroupCallSignal;
        expect(offer).toMatchObject({
            type: "offer",
            roomId: room.roomId,
            from: "adm",
            sdp: "v=0 adm",
        });
        await app.call(
            "call.group.signal",
            { roomId: room.roomId, to: "adm", type: "answer", sdp: "v=0 own" },
            owner.user,
        );
        expect(
            app.eventsFor(invited[0].user.id, "group:call:signal").at(-1)
                ?.payload,
        ).toMatchObject({ type: "answer", from: "own" });
        await app.call(
            "call.group.signal",
            {
                roomId: room.roomId,
                to: "adm",
                type: "ice",
                candidate: { candidate: "x" },
            },
            owner.user,
        );
        expect(
            app.eventsFor(invited[0].user.id, "group:call:signal").at(-1)
                ?.payload,
        ).toMatchObject({ type: "ice", candidate: { candidate: "x" } });
    });

    it("rejects malformed signals and outsiders", async () => {
        const { app, owner, invited, stranger, group } = await setup();
        const room = await start(app, owner, group.id);
        await app.call(
            "call.group.join",
            { roomId: room.roomId },
            invited[0].user,
        );
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "own", type: "offer", sdp: "x" },
                stranger.user,
            ),
        ).rejects.toThrow("你不在该通话中");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: "gone", to: "own", type: "offer", sdp: "x" },
                owner.user,
            ),
        ).rejects.toThrow("通话已结束");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "adm", type: "hack", sdp: "x" },
                owner.user,
            ),
        ).rejects.toThrow("非法信令类型");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "adm", type: "offer" },
                owner.user,
            ),
        ).rejects.toThrow("缺少 SDP");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "adm", type: "ice", candidate: 1 },
                owner.user,
            ),
        ).rejects.toThrow("非法 ICE 候选");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "str", type: "offer", sdp: "x" },
                owner.user,
            ),
        ).rejects.toThrow("对方不在该通话中");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "own", type: "offer", sdp: "x" },
                owner.user,
            ),
        ).rejects.toThrow("对方不在该通话中");
        await expect(
            app.call(
                "call.group.signal",
                { roomId: room.roomId, to: "adm", type: "offer", sdp: "x" },
                invited[0].user,
            ),
        ).rejects.toThrow("对方不在该通话中");
    });

    it("caps the room at six members", async () => {
        const app = await createTestApp();
        const owner = await app.register("own");
        const names = ["m1", "m2", "m3", "m4", "m5", "m6"];
        const users: { user: { id: string } }[] = [];
        for (const name of names) users.push(await app.register(name));
        const group = (await app.call(
            "group.create",
            { name: "大群", members: names },
            owner.user,
        )) as { id: string };
        const room = await start(app, owner, group.id);
        for (const user of users.slice(0, 5))
            await app.call(
                "call.group.join",
                { roomId: room.roomId },
                user.user,
            );
        await expect(
            app.call("call.group.join", { roomId: room.roomId }, users[5].user),
        ).rejects.toThrow("最多 6 人");
        const info = (await app.call(
            "call.group.info",
            { groupId: group.id },
            owner.user,
        )) as { members: string[] };
        expect(info.members).toHaveLength(6);
        await app.call(
            "call.group.join",
            { roomId: room.roomId },
            users[0].user,
        );
        expect(
            (
                (await app.call(
                    "call.group.info",
                    { groupId: group.id },
                    owner.user,
                )) as { members: string[] }
            ).members,
        ).toHaveLength(6);
    });

    it("keeps one room per group and one call per user", async () => {
        const { app, owner, invited, group } = await setup();
        const room = await start(app, owner, group.id);
        await expect(
            app.call("call.group.start", { groupId: group.id }, owner.user),
        ).rejects.toThrow("你正在进行通话");
        await expect(
            app.call(
                "call.group.start",
                { groupId: group.id },
                invited[0].user,
            ),
        ).rejects.toThrow("该群已有通话进行中");
        await app.call(
            "call.group.join",
            { roomId: room.roomId },
            invited[0].user,
        );
        await expect(
            app.call("call.group.start", { groupId: group.id }, owner.user),
        ).rejects.toThrow("你正在进行通话");
        const other = (await app.call(
            "group.create",
            { name: "另一个", members: ["adm"] },
            invited[0].user,
        )) as { id: string };
        await expect(
            app.call(
                "call.group.start",
                { groupId: other.id },
                invited[0].user,
            ),
        ).rejects.toThrow("你正在进行通话");
        await expect(
            app.call("call.group.join", { roomId: room.roomId }),
        ).rejects.toThrow("未登录");
    });

    it("blocks a 1v1 call while a room is active", async () => {
        const { app, owner, invited, group } = await setup();
        await app.call("friend.request", { username: "adm" }, owner.user);
        await app.call("friend.accept", { username: "own" }, invited[0].user);
        app.setOnline(owner.user);
        app.setOnline(invited[0].user);
        const room = await start(app, owner, group.id);
        await expect(
            app.call("screen.invite", { to: "adm" }, owner.user),
        ).rejects.toThrow("你正在进行通话");
        await expect(
            app.call("screen.invite", { to: "own" }, invited[0].user),
        ).rejects.toThrow("对方正忙");
        await app.call(
            "call.group.join",
            { roomId: room.roomId },
            invited[0].user,
        );
        await expect(
            app.call("screen.invite", { to: "own" }, invited[0].user),
        ).rejects.toThrow("你正在进行通话");
        await expect(
            app.call("screen.invite", { to: "adm" }, owner.user),
        ).rejects.toThrow("你正在进行通话");
    });

    it("ends the room when the host leaves and drops it on disconnect", async () => {
        const { app, owner, invited, group } = await setup(["adm", "mem"]);
        app.setOnline(owner.user);
        const room = await start(app, owner, group.id);
        await app.call(
            "call.group.join",
            { roomId: room.roomId },
            invited[0].user,
        );
        await app.call("call.group.leave", { roomId: room.roomId }, owner.user);
        expect(lastEvent(app, invited[0].user.id)).toMatchObject({
            type: "end",
            from: "own",
        });
        expect(lastEvent(app, invited[1].user.id)).toMatchObject({
            type: "invite",
        });
        await expect(
            app.call(
                "call.group.join",
                { roomId: room.roomId },
                invited[1].user,
            ),
        ).rejects.toThrow("通话已结束");
        expect(
            await app.call(
                "call.group.info",
                { groupId: group.id },
                owner.user,
            ),
        ).toBeNull();
        const second = await start(app, owner, group.id);
        await app.call(
            "call.group.join",
            { roomId: second.roomId },
            invited[0].user,
        );
        await app.call(
            "call.group.join",
            { roomId: second.roomId },
            invited[1].user,
        );
        await app.call(
            "call.group.leave",
            { roomId: second.roomId },
            invited[0].user,
        );
        expect(lastEvent(app, invited[1].user.id)).toMatchObject({
            type: "leave",
            from: "adm",
        });
        expect(
            (
                (await app.call(
                    "call.group.info",
                    { groupId: group.id },
                    owner.user,
                )) as { members: string[] }
            ).members,
        ).toEqual(["own", "mem"]);
        app.goOffline(owner.user.id);
        expect(lastEvent(app, invited[1].user.id)).toMatchObject({
            type: "end",
            from: "own",
        });
        expect(
            await app.call(
                "call.group.info",
                { groupId: group.id },
                owner.user,
            ),
        ).toBeNull();
    });

    it("lets only the host end the room", async () => {
        const { app, owner, invited, group } = await setup();
        const room = await start(app, owner, group.id);
        await app.call(
            "call.group.join",
            { roomId: room.roomId },
            invited[0].user,
        );
        await expect(
            app.call(
                "call.group.end",
                { roomId: room.roomId },
                invited[0].user,
            ),
        ).rejects.toThrow("只有发起人可以结束通话");
        await app.call("call.group.end", { roomId: room.roomId }, owner.user);
        expect(lastEvent(app, invited[0].user.id)).toMatchObject({
            type: "end",
            from: "own",
        });
        await expect(
            app.call(
                "call.group.join",
                { roomId: room.roomId },
                invited[0].user,
            ),
        ).rejects.toThrow("通话已结束");
        await expect(
            app.call("call.group.leave", { roomId: "ghost" }, owner.user),
        ).resolves.toBe(true);
        await expect(
            app.call("call.group.end", { roomId: "ghost" }, owner.user),
        ).resolves.toBe(true);
    });

    it("requires a session and group membership", async () => {
        const { app, owner, stranger, group } = await setup();
        await expect(
            app.call("call.group.start", { groupId: group.id }),
        ).rejects.toThrow("未登录");
        await expect(
            app.call("call.group.start", { groupId: group.id }, stranger.user),
        ).rejects.toThrow("你不在该群");
        await expect(
            app.call("call.group.start", { groupId: "nope" }, owner.user),
        ).rejects.toThrow("群组不存在");
    });
});
