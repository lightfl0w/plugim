import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

describe("auth rpc", () => {
    it("registers, issues a verifiable token and reports me", async () => {
        const app = await createTestApp();
        const { user, token } = await app.register("alice");
        expect(user.username).toBe("alice");
        const verified = await app.verify(token);
        expect(verified).toEqual(user);
        const me = await app.call("auth.me", {}, user);
        expect(me).toMatchObject({ id: user.id, username: "alice" });
    });

    it("rejects invalid usernames and short passwords", async () => {
        const app = await createTestApp();
        await expect(app.register("A")).rejects.toThrow("2-24");
        await expect(app.register("ok name")).rejects.toThrow("2-24");
        await expect(
            app.call("auth.register", { username: "bob", password: "123" }),
        ).rejects.toThrow("6 位");
    });

    it("rejects duplicate usernames", async () => {
        const app = await createTestApp();
        await app.register("carol");
        await expect(app.register("carol")).rejects.toThrow("占用");
    });

    it("logs in with correct password and fails otherwise", async () => {
        const app = await createTestApp();
        await app.register("dave");
        await expect(app.login("dave", "wrong-pass")).rejects.toThrow(
            "用户名或密码错误",
        );
        const { token } = await app.login("dave");
        expect(await app.verify(token)).not.toBeNull();
    });

    it("blocks banned accounts from login and token verification", async () => {
        const app = await createTestApp();
        const { user, token } = await app.register("erin");
        const accounts = app.ctx.get<{
            setFlag(
                id: string,
                flag: "isAdmin" | "banned",
                value: boolean,
            ): Promise<void>;
        }>("accounts");
        await accounts.setFlag(user.id, "banned", true);
        await expect(app.verify(token)).resolves.toBeNull();
        await expect(app.login("erin")).rejects.toThrow("封禁");
    });

    it("returns public user info and hides unknown users", async () => {
        const app = await createTestApp();
        const { user } = await app.register("frank");
        const info = await app.call("user.info", { username: "frank" }, user);
        expect(info).toMatchObject({ username: "frank" });
        expect(
            (info as { createdAt: string }).createdAt,
        ).toMatch(/^\d{4}-/);
        await expect(
            app.call("user.info", { username: "ghost" }, user),
        ).rejects.toThrow("不存在");
    });

    it("promotes bootstrap admins on register", async () => {
        const app = await createTestApp({ admins: ["grace"] });
        const { user } = await app.register("grace");
        const accounts = app.ctx.get<{
            fullById(id: string): Promise<{ isAdmin: boolean } | null>;
        }>("accounts");
        const row = await accounts.fullById(user.id);
        expect(row?.isAdmin).toBe(true);
    });
});
