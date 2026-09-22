import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const adminSetup = async () => {
    const app = await createTestApp({ admins: ["root"] });
    const root = await app.register("root");
    const victim = await app.register("vic");
    return { app, root, victim };
};

describe("admin rpc", () => {
    it("rejects non-admins on every admin method", async () => {
        const { app, victim } = await adminSetup();
        for (const method of ["admin.users", "admin.groups", "admin.stats"]) {
            await expect(app.call(method, {}, victim.user)).rejects.toThrow(
                "管理员",
            );
        }
        await expect(
            app.call(
                "admin.ban",
                { userId: victim.user.id, on: true },
                victim.user,
            ),
        ).rejects.toThrow("管理员");
    });

    it("lists users with online flags", async () => {
        const { app, root } = await adminSetup();
        app.setOnline(root.user);
        const users = (await app.call("admin.users", {}, root.user)) as {
            username: string;
            online: boolean;
            isAdmin: boolean;
        }[];
        expect(users).toHaveLength(2);
        expect(users.find((u) => u.username === "root")).toMatchObject({
            online: true,
            isAdmin: true,
        });
        expect(users.find((u) => u.username === "vic")?.online).toBe(false);
    });

    it("bans users, kicks sessions and blocks login", async () => {
        const { app, root, victim } = await adminSetup();
        app.setOnline(victim.user);
        await app.call(
            "admin.ban",
            { userId: victim.user.id, on: true },
            root.user,
        );
        const users = (await app.call("admin.users", {}, root.user)) as {
            username: string;
            online: boolean;
            banned: boolean;
        }[];
        expect(users.find((u) => u.username === "vic")).toMatchObject({
            online: false,
            banned: true,
        });
        await expect(app.login("vic")).rejects.toThrow("封禁");
    });

    it("refuses self-ban", async () => {
        const { app, root } = await adminSetup();
        await expect(
            app.call(
                "admin.ban",
                { userId: root.user.id, on: true },
                root.user,
            ),
        ).rejects.toThrow("自己");
    });

    it("grants and revokes admin", async () => {
        const { app, root, victim } = await adminSetup();
        await app.call(
            "admin.grant",
            { userId: victim.user.id, on: true },
            root.user,
        );
        await expect(
            app.call("admin.stats", {}, victim.user),
        ).resolves.toBeTruthy();
        await app.call(
            "admin.grant",
            { userId: victim.user.id, on: false },
            root.user,
        );
        await expect(app.call("admin.stats", {}, victim.user)).rejects.toThrow(
            "管理员",
        );
    });

    it("lists groups with owner names and disbands them", async () => {
        const { app, root, victim } = await adminSetup();
        const group = (await app.call(
            "group.create",
            { name: "待解散群", members: ["root"] },
            victim.user,
        )) as { id: string };
        const groups = (await app.call("admin.groups", {}, root.user)) as {
            id: string;
            ownerName: string;
            memberCount: number;
        }[];
        expect(groups[0]).toMatchObject({
            id: group.id,
            ownerName: "vic",
            memberCount: 2,
        });
        await app.call("admin.group.delete", { groupId: group.id }, root.user);
        expect(await app.call("admin.groups", {}, root.user)).toHaveLength(0);
    });

    it("reports system stats", async () => {
        const { app, root } = await adminSetup();
        const stats = (await app.call("admin.stats", {}, root.user)) as {
            users: number;
            groups: number;
            connections: number;
        };
        expect(stats).toEqual({
            users: 2,
            groups: 0,
            connections: 1,
        });
    });
});
