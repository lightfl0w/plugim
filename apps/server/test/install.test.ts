import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

describe("install wizard", () => {
    it("tests and saves sqlite db config into install.json", async () => {
        const app = await createTestApp();
        const dir = mkdtempSync(join(tmpdir(), "plugim-db-"));
        const target = join(dir, "chosen.db");
        expect(
            await app.call("install.testdb", {
                dbDriver: "sqlite",
                dbFile: target,
                logDir: "",
            }),
        ).toBe(true);
        expect(
            await app.call("install.savedb", {
                dbDriver: "sqlite",
                dbFile: target,
                logDir: join(dir, "logs"),
            }),
        ).toBe(true);
        const status = await app.call("install.status");
        expect(status).toMatchObject({
            dbFile: target,
            logDir: join(dir, "logs"),
        });
    });

    it("rejects malformed db file, url and log dir", async () => {
        const app = await createTestApp();
        await expect(
            app.call("install.testdb", {
                dbDriver: "sqlite",
                dbFile: "has space.db",
            }),
        ).rejects.toThrow("数据库文件名");
        await expect(
            app.call("install.testdb", {
                dbDriver: "postgres",
                databaseUrl: "mysql://nope",
            }),
        ).rejects.toThrow("postgres://");
        await expect(
            app.call("install.testdb", {
                dbDriver: "sqlite",
                dbFile: "ok.db",
                logDir: "bad dir!",
            }),
        ).rejects.toThrow("日志目录");
    });

    it("rejects unreachable postgres url in testdb", async () => {
        const app = await createTestApp();
        await expect(
            app.call("install.testdb", {
                dbDriver: "postgres",
                databaseUrl: "postgres://u:p@127.0.0.1:59999/nope",
            }),
        ).rejects.toThrow("连接失败");
    });

    it("reports fresh status, finishes once and locks the door", async () => {
        const app = await createTestApp();
        expect(await app.call("install.status")).toMatchObject({
            installed: false,
            hasUsers: false,
            inviteRequired: false,
        });
        expect(await app.call("install.finish", {})).toBe(true);
        expect(await app.call("install.status")).toMatchObject({
            installed: true,
        });
        await expect(app.call("install.finish", {})).rejects.toThrow(
            "完成初始化",
        );
    });

    it("finish persists register policy that overrides env defaults", async () => {
        const app = await createTestApp();
        await app.register("rootuser");
        await app.call("install.finish", {
            allowRegister: false,
            inviteCode: "key9",
        });
        await expect(app.register("guest")).rejects.toThrow("邀请码");
        const ok = await app.call("auth.register", {
            username: "guest",
            password: "Passw0rd!",
            inviteCode: "key9",
        });
        expect(ok).toBeTruthy();
        expect(await app.call("install.status")).toMatchObject({
            inviteRequired: true,
        });
    });

    it("treats a database with existing users as installed (legacy upgrade)", async () => {
        const app = await createTestApp();
        await app.register("legacy1");
        expect(await app.call("install.status")).toMatchObject({
            installed: true,
            hasUsers: true,
        });
        await app.call("install.finish", { allowRegister: false });
        await expect(app.call("install.finish", {})).rejects.toThrow(
            "完成初始化",
        );
    });

    it("closed policy without invite code blocks register after bootstrap", async () => {
        const app = await createTestApp();
        await app.register("rootuser");
        await app.call("install.finish", { allowRegister: false });
        expect(await app.call("install.status")).toMatchObject({
            allowRegister: false,
            hasUsers: true,
        });
        await expect(app.register("guest")).rejects.toThrow("已关闭注册");
    });
});
