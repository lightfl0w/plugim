import type { GroupInfo, GroupMember } from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const setup = async () => {
    const app = await createTestApp();
    const owner = await app.register("own");
    const admin = await app.register("adm");
    const member = await app.register("mem");
    const stranger = await app.register("str");
    const group = (await app.call(
        "group.create",
        { name: "项目组", members: ["adm", "mem"] },
        owner.user,
    )) as GroupInfo;
    return { app, owner, admin, member, stranger, group };
};

describe("group lifecycle", () => {
    it("creates with owner role and lists for members", async () => {
        const { app, owner, member, group } = await setup();
        expect(group.myRole).toBe("owner");
        expect(group.memberCount).toBe(3);
        const ownList = (await app.call(
            "group.list",
            {},
            owner.user,
        )) as GroupInfo[];
        const memberList = (await app.call(
            "group.list",
            {},
            member.user,
        )) as GroupInfo[];
        expect(ownList.map((g) => g.id)).toEqual([group.id]);
        expect(memberList.map((g) => g.id)).toEqual([group.id]);
        await expect(
            app.call("group.info", { groupId: group.id }, (
                await app.register("nobody")
            ).user),
        ).rejects.toThrow("不在该群");
    });

    it("rejects short names", async () => {
        const { app, owner } = await setup();
        await expect(
            app.call("group.create", { name: "x" }, owner.user),
        ).rejects.toThrow("至少 2");
    });

    it("promotes and demotes admins, owner only", async () => {
        const { app, owner, admin, group } = await setup();
        await expect(
            app.call(
                "group.member.role",
                { groupId: group.id, username: "mem", role: "admin" },
                admin.user,
            ),
        ).rejects.toThrow("群主");
        await app.call(
            "group.member.role",
            { groupId: group.id, username: "mem", role: "admin" },
            owner.user,
        );
        const promoted = (await app.call(
            "group.members",
            { groupId: group.id },
            owner.user,
        )) as { members: GroupMember[] };
        expect(
            promoted.members.find((m) => m.username === "mem")?.role,
        ).toBe("admin");
        await app.call(
            "group.member.role",
            { groupId: group.id, username: "mem", role: "member" },
            owner.user,
        );
        expect(admin.user.username).toBe("adm");
    });

    it("removes members as admin and lets members leave themselves", async () => {
        const { app, admin, member, group } = await setup();
        await app.call(
            "group.member.remove",
            { groupId: group.id, username: "mem" },
            member.user,
        );
        const afterLeave = (await app.call(
            "group.members",
            { groupId: group.id },
            admin.user,
        )) as { members: GroupMember[] };
        expect(afterLeave.members.map((m) => m.username)).not.toContain("mem");
        await expect(
            app.call(
                "group.info",
                { groupId: group.id },
                member.user,
            ),
        ).rejects.toThrow("不在该群");
    });

    it("owner cannot leave; disband removes the group", async () => {
        const { app, owner, group } = await setup();
        await expect(
            app.call("group.leave", { groupId: group.id }, owner.user),
        ).rejects.toThrow("解散");
        await app.call("group.delete", { groupId: group.id }, owner.user);
        await expect(
            app.call("group.info", { groupId: group.id }, owner.user),
        ).rejects.toThrow("不存在");
    });

    it("updates notice and notifies members", async () => {
        const { app, owner, group } = await setup();
        await app.call(
            "group.notice.set",
            { groupId: group.id, notice: "周五开会" },
            owner.user,
        );
        const info = (await app.call(
            "group.info",
            { groupId: group.id },
            owner.user,
        )) as GroupInfo;
        expect(info.notice).toBe("周五开会");
        expect(app.events.some((e) => e.name === "group:update")).toBe(true);
    });
});

describe("friends vs groups", () => {
    it("blocks friend requests between group members", async () => {
        const app = await createTestApp();
        const a = await app.register("fa");
        const b = await app.register("fb");
        await app.call(
            "group.create",
            { name: "共同群", members: ["fb"] },
            a.user,
        );
        await expect(
            app.call("friend.request", { username: "fb" }, a.user),
        ).rejects.toThrow("群成员");
    });

    it("allows friend requests between non-members", async () => {
        const app = await createTestApp();
        const a = await app.register("ga2");
        await app.register("gb2");
        await expect(
            app.call("friend.request", { username: "gb2" }, a.user),
        ).resolves.toBeTruthy();
    });
});
