import type {
    GroupInfo,
    GroupJoinRequest,
    GroupJoinResult,
    GroupMember,
} from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const setup = async () => {
    const app = await createTestApp();
    const owner = await app.register("own");
    const joiner = await app.register("join");
    const group = (await app.call(
        "group.create",
        { name: "项目组" },
        owner.user,
    )) as GroupInfo;
    return { app, owner, joiner, group };
};

const members = async (
    app: Awaited<ReturnType<typeof createTestApp>>,
    groupId: string,
    user: { id: string },
) =>
    (
        (await app.call("group.members", { groupId }, user)) as {
            members: GroupMember[];
        }
    ).members.map((item) => item.username);

describe("group invite", () => {
    it("generates a code visible only to managers", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        expect(withCode.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
        expect(withCode.inviteExpiresAt).toBeNull();

        await app.call(
            "group.member.add",
            { groupId: group.id, usernames: ["join"] },
            owner.user,
        );
        const asMember = (await app.call(
            "group.info",
            { groupId: group.id },
            joiner.user,
        )) as GroupInfo;
        expect(asMember.inviteCode).toBeNull();
    });

    it("sets and clears expiry, and disables the code", async () => {
        const { app, owner, group } = await setup();
        const timed = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "7d" },
            owner.user,
        )) as GroupInfo;
        const expires = new Date(timed.inviteExpiresAt ?? "").getTime();
        expect(expires).toBeGreaterThan(Date.now() + 6 * 86_400_000);
        expect(expires).toBeLessThan(Date.now() + 8 * 86_400_000);

        const disabled = (await app.call(
            "group.invite.disable",
            { groupId: group.id },
            owner.user,
        )) as GroupInfo;
        expect(disabled.inviteCode).toBeNull();
    });

    it("rejects non managers and bad ttl", async () => {
        const { app, owner, joiner, group } = await setup();
        await app.call(
            "group.member.add",
            { groupId: group.id, usernames: ["join"] },
            owner.user,
        );
        await expect(
            app.call(
                "group.invite.set",
                { groupId: group.id, expiresIn: "never" },
                joiner.user,
            ),
        ).rejects.toThrow("权限");
        await expect(
            app.call(
                "group.invite.set",
                { groupId: group.id, expiresIn: "1d" },
                owner.user,
            ),
        ).rejects.toThrow("非法有效期");
    });
});

describe("group join by code", () => {
    it("joins directly when approval is off", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.joinApproval",
            { groupId: group.id, on: false },
            owner.user,
        );
        const result = (await app.call(
            "group.join",
            { code: withCode.inviteCode },
            joiner.user,
        )) as GroupJoinResult;
        expect(result.status).toBe("joined");
        expect(result.groupId).toBe(group.id);
        expect(await members(app, group.id, owner.user)).toEqual([
            "own",
            "join",
        ]);
        expect(
            app.eventsFor(joiner.user.id, "group:update").length,
        ).toBeGreaterThan(0);
    });

    it("queues a request when approval is on and notifies managers", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        const result = (await app.call(
            "group.join",
            { code: withCode.inviteCode, message: "我是新同事" },
            joiner.user,
        )) as GroupJoinResult;
        expect(result.status).toBe("pending");
        expect(await members(app, group.id, owner.user)).toEqual(["own"]);
        expect(app.eventsFor(owner.user.id, "group:request")).toEqual([
            {
                name: "group:request",
                userId: owner.user.id,
                payload: { groupId: group.id, username: "join" },
            },
        ]);
        const list = (await app.call(
            "group.requests",
            { groupId: group.id },
            owner.user,
        )) as GroupJoinRequest[];
        expect(list).toHaveLength(1);
        expect(list[0].username).toBe("join");
        expect(list[0].message).toBe("我是新同事");
    });

    it("dedupes repeat requests and hides the queue from members", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.join",
            { code: withCode.inviteCode, message: "第一次" },
            joiner.user,
        );
        await app.call(
            "group.join",
            { code: withCode.inviteCode, message: "第二次" },
            joiner.user,
        );
        const list = (await app.call(
            "group.requests",
            { groupId: group.id },
            owner.user,
        )) as GroupJoinRequest[];
        expect(list).toHaveLength(1);
        expect(list[0].message).toBe("第二次");
        await expect(
            app.call("group.requests", { groupId: group.id }, joiner.user),
        ).rejects.toThrow("不在该群");
    });

    it("rejects expired, unknown and disabled codes", async () => {
        const { app, owner, joiner, group } = await setup();
        await expect(
            app.call("group.join", { code: "ZZZZZZZZ" }, joiner.user),
        ).rejects.toThrow("无效或已过期");
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.invite.disable",
            { groupId: group.id },
            owner.user,
        );
        await expect(
            app.call("group.join", { code: withCode.inviteCode }, joiner.user),
        ).rejects.toThrow("无效或已过期");
    });

    it("returns joined for existing members", async () => {
        const { app, owner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        const result = (await app.call(
            "group.join",
            { code: withCode.inviteCode.toLowerCase() },
            owner.user,
        )) as GroupJoinResult;
        expect(result.status).toBe("joined");
    });
});

describe("group join approval", () => {
    it("approves a pending request into the group", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.join",
            { code: withCode.inviteCode },
            joiner.user,
        );
        await app.call(
            "group.request.approve",
            { groupId: group.id, username: "join", on: true },
            owner.user,
        );
        expect(await members(app, group.id, owner.user)).toEqual([
            "own",
            "join",
        ]);
        const list = (await app.call(
            "group.requests",
            { groupId: group.id },
            owner.user,
        )) as GroupJoinRequest[];
        expect(list).toHaveLength(0);
        const info = (await app.call(
            "group.info",
            { groupId: group.id },
            owner.user,
        )) as GroupInfo;
        expect(info.pendingRequests).toBe(0);
        expect(info.memberCount).toBe(2);
    });

    it("rejects a pending request without joining", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.join",
            { code: withCode.inviteCode },
            joiner.user,
        );
        await app.call(
            "group.request.approve",
            { groupId: group.id, username: "join", on: false },
            owner.user,
        );
        expect(await members(app, group.id, owner.user)).toEqual(["own"]);
        await expect(
            app.call(
                "group.request.approve",
                { groupId: group.id, username: "join", on: true },
                owner.user,
            ),
        ).rejects.toThrow("已处理");
    });

    it("counts pending requests for managers only", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.join",
            { code: withCode.inviteCode },
            joiner.user,
        );
        const asOwner = (await app.call(
            "group.list",
            {},
            owner.user,
        )) as GroupInfo[];
        expect(asOwner[0].pendingRequests).toBe(1);
        await app.call(
            "group.member.add",
            { groupId: group.id, usernames: ["join"] },
            owner.user,
        );
        const asMember = (await app.call(
            "group.list",
            {},
            joiner.user,
        )) as GroupInfo[];
        expect(asMember[0].pendingRequests).toBe(0);
        const cleared = (await app.call(
            "group.requests",
            { groupId: group.id },
            owner.user,
        )) as GroupJoinRequest[];
        expect(cleared).toHaveLength(0);
    });

    it("drops pending requests when the group is deleted", async () => {
        const { app, owner, joiner, group } = await setup();
        const withCode = (await app.call(
            "group.invite.set",
            { groupId: group.id, expiresIn: "never" },
            owner.user,
        )) as GroupInfo;
        await app.call(
            "group.join",
            { code: withCode.inviteCode },
            joiner.user,
        );
        await app.call("group.delete", { groupId: group.id }, owner.user);
        await expect(
            app.call("group.requests", { groupId: group.id }, owner.user),
        ).rejects.toThrow("群组不存在");
    });
});
