import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const groupSetup = async () => {
    const app = await createTestApp();
    const owner = await app.register("own");
    const member = await app.register("mem");
    const outsider = await app.register("out");
    const group = (await app.call(
        "group.create",
        { name: "项目组", members: ["mem"] },
        owner.user,
    )) as { id: string };
    return { app, owner, member, outsider, group };
};

const typingEvents = (
    app: Awaited<ReturnType<typeof createTestApp>>,
    userId: string,
) =>
    app
        .eventsFor(userId, "typing")
        .map((event) => event.payload as { session: string; username: string });

describe("typing indicator", () => {
    it("relays group typing to every other member", async () => {
        const { app, owner, member, group } = await groupSetup();
        const sent = await app.call(
            "typing.send",
            { session: `g:${group.id}` },
            member.user,
        );
        expect(sent).toBe(true);
        expect(typingEvents(app, owner.user.id)).toEqual([
            { session: `g:${group.id}`, username: "mem" },
        ]);
        expect(typingEvents(app, member.user.id)).toEqual([]);
    });

    it("mirrors p2p typing to the peer session", async () => {
        const app = await createTestApp();
        const ua = await app.register("ta");
        const ub = await app.register("tb");
        await app.call("friend.request", { username: "tb" }, ua.user);
        await app.call("friend.accept", { username: "ta" }, ub.user);
        await app.call("typing.send", { session: "p2p:tb" }, ua.user);
        expect(typingEvents(app, ub.user.id)).toEqual([
            { session: "p2p:ta", username: "ta" },
        ]);
    });

    it("throttles repeat typing from the same user", async () => {
        const { app, owner, member, group } = await groupSetup();
        await app.call(
            "typing.send",
            { session: `g:${group.id}` },
            member.user,
        );
        const second = await app.call(
            "typing.send",
            { session: `g:${group.id}` },
            member.user,
        );
        expect(second).toBe(false);
        expect(typingEvents(app, owner.user.id)).toHaveLength(1);
    });

    it("rejects typing from strangers and empty sessions", async () => {
        const { app, outsider, group } = await groupSetup();
        await expect(
            app.call(
                "typing.send",
                { session: `g:${group.id}` },
                outsider.user,
            ),
        ).rejects.toThrow("不在该群");
        expect(
            await app.call("typing.send", { session: "" }, outsider.user),
        ).toBe(false);
    });
});

describe("mention all", () => {
    const sendAs = (
        app: Awaited<ReturnType<typeof createTestApp>>,
        user: { id: string },
        groupId: string,
        mentions: string[],
    ) =>
        app.call(
            "message.send",
            {
                session: `g:${groupId}`,
                content: "@全体成员 晚点开会",
                mentions,
            },
            user,
        );

    it("allows the owner and admins to mention everyone", async () => {
        const { app, owner, member, group } = await groupSetup();
        const asOwner = (await sendAs(app, owner.user, group.id, ["@all"])) as {
            mentions: string[] | null;
        };
        expect(asOwner.mentions).toEqual(["@all"]);
        await app.call(
            "group.member.role",
            { groupId: group.id, username: "mem", role: "admin" },
            owner.user,
        );
        const asAdmin = (await sendAs(app, member.user, group.id, [
            "mem",
            "@all",
        ])) as { mentions: string[] | null };
        expect(asAdmin.mentions).toEqual(["mem", "@all"]);
    });

    it("blocks plain members and p2p mentions", async () => {
        const { app, member, group } = await groupSetup();
        await expect(
            sendAs(app, member.user, group.id, ["@all"]),
        ).rejects.toThrow("只有群主或管理员");
        const app2 = await createTestApp();
        const ua = await app2.register("ma");
        const ub = await app2.register("mb");
        await app2.call("friend.request", { username: "mb" }, ua.user);
        await app2.call("friend.accept", { username: "ma" }, ub.user);
        await expect(
            app2.call(
                "message.send",
                { session: "p2p:mb", content: "@全体成员", mentions: ["@all"] },
                ua.user,
            ),
        ).rejects.toThrow("只有群聊支持");
    });

    it("keeps ordinary mentions untouched", async () => {
        const { app, member, group } = await groupSetup();
        const sent = (await sendAs(app, member.user, group.id, ["own"])) as {
            mentions: string[] | null;
        };
        expect(sent.mentions).toEqual(["own"]);
    });
});
