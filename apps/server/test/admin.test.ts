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
            messages: number;
            mediaBytes: number;
            retentionDays: number;
        };
        expect(stats).toMatchObject({
            users: 2,
            groups: 0,
            connections: 1,
            messages: 0,
            mediaBytes: 0,
            retentionDays: 0,
        });
    });

    it("searches messages by keyword and sender", async () => {
        const { app, root } = await adminSetup();
        const bob = await app.register("bob");
        await app.call(
            "message.send",
            { session: "general", content: "部署手册第一版" },
            root.user,
        );
        await app.call(
            "message.send",
            { session: "general", content: "午饭吃什么" },
            bob.user,
        );
        const hit = (await app.call(
            "admin.messages",
            { keyword: "部署" },
            root.user,
        )) as { rows: { sender: string }[]; total: number };
        expect(hit.total).toBe(1);
        expect(hit.rows[0].sender).toBe("root");
        const bySender = (await app.call(
            "admin.messages",
            { sender: "bob" },
            root.user,
        )) as { total: number };
        expect(bySender.total).toBe(1);
        await expect(app.call("admin.messages", {}, bob.user)).rejects.toThrow(
            "需要管理员权限",
        );
    });

    it("lists media files with byte totals", async () => {
        const { app, root } = await adminSetup();
        await app.call(
            "message.send",
            { session: "general", content: "text only" },
            root.user,
        );
        await app.call(
            "message.send",
            {
                session: "general",
                content: "data:image/png;base64,AAAA",
                kind: "image",
                file: { name: "a.png", size: 24 },
            },
            root.user,
        );
        const files = (await app.call("admin.files", {}, root.user)) as {
            rows: { kind: string }[];
            total: number;
            totalBytes: number;
        };
        expect(files.total).toBe(1);
        expect(files.rows[0].kind).toBe("image");
        expect(files.totalBytes).toBeGreaterThan(0);
    });

    it("stores retention policy and rejects invalid values", async () => {
        const { app, root } = await adminSetup();
        await app.call(
            "message.send",
            { session: "general", content: "新的" },
            root.user,
        );
        await expect(app.call("admin.cleanup", {}, root.user)).rejects.toThrow(
            "尚未设置保留天数",
        );
        await expect(
            app.call("admin.retention.set", { days: 1.5 }, root.user),
        ).rejects.toThrow("保留天数");
        await expect(
            app.call("admin.retention.set", { days: 99999 }, root.user),
        ).rejects.toThrow("保留天数");
        await app.call("admin.retention.set", { days: 30 }, root.user);
        expect(await app.call("admin.retention.get", {}, root.user)).toEqual({
            days: 30,
        });
        const result = (await app.call("admin.cleanup", {}, root.user)) as {
            deleted: number;
        };
        expect(result.deleted).toBe(0);
        const stats = (await app.call("admin.stats", {}, root.user)) as {
            messages: number;
            retentionDays: number;
        };
        expect(stats).toMatchObject({ messages: 1, retentionDays: 30 });
    });
});
