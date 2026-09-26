import { describe, expect, it } from "vitest";
import { createTestApp } from "./helpers";

const waitFor = async (check: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 40; i += 1) {
        if (check()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
};

describe("password change", () => {
    it("swaps the token and keeps the session valid", async () => {
        const app = await createTestApp();
        const { user, token } = await app.register("alice");
        const result = (await app.call(
            "auth.password",
            { oldPassword: "Passw0rd!", newPassword: "Fresh-Pass1" },
            user,
        )) as { token: string };
        expect(result.token).not.toBe(token);
        await expect(app.verify(token)).resolves.toBeNull();
        await expect(app.verify(result.token)).resolves.toEqual(user);
        const relogin = await app.login("alice", "Fresh-Pass1");
        await expect(app.verify(relogin.token)).resolves.toEqual(user);
        await expect(app.login("alice", "Passw0rd!")).rejects.toThrow(
            "用户名或密码错误",
        );
    });

    it("kicks other connections after the change", async () => {
        const app = await createTestApp();
        const { user } = await app.register("bob");
        app.setOnline(user);
        await app.call(
            "auth.password",
            { oldPassword: "Passw0rd!", newPassword: "Another-Pass2" },
            user,
        );
        const kicked = await waitFor(
            () => app.eventsFor(user.id, "kick").length === 1,
        );
        expect(kicked).toBe(true);
    });

    it("rejects wrong old password, short and repeated passwords", async () => {
        const app = await createTestApp();
        const { user } = await app.register("carol");
        await expect(
            app.call(
                "auth.password",
                { oldPassword: "nope", newPassword: "Another-Pass2" },
                user,
            ),
        ).rejects.toThrow("原密码不正确");
        await expect(
            app.call(
                "auth.password",
                { oldPassword: "Passw0rd!", newPassword: "123" },
                user,
            ),
        ).rejects.toThrow("6 位");
        await expect(
            app.call(
                "auth.password",
                { oldPassword: "Passw0rd!", newPassword: "Passw0rd!" },
                user,
            ),
        ).rejects.toThrow("不能与原密码相同");
    });

    it("invalidates every previously issued token", async () => {
        const app = await createTestApp();
        const { user, token: first } = await app.register("dave");
        const { token: second } = await app.login("dave");
        await app.call(
            "auth.password",
            { oldPassword: "Passw0rd!", newPassword: "Third-Pass3" },
            user,
        );
        await expect(app.verify(first)).resolves.toBeNull();
        await expect(app.verify(second)).resolves.toBeNull();
    });
});

describe("admin password reset", () => {
    it("lets an admin reset another user and drops their tokens", async () => {
        const app = await createTestApp({ admins: ["root"] });
        const admin = await app.register("root");
        const { user, token } = await app.register("erin");
        await expect(
            app.call(
                "admin.password",
                { userId: user.id, password: "Reset-Pass9" },
                user,
            ),
        ).rejects.toThrow("管理员");
        await app.call(
            "admin.password",
            { userId: user.id, password: "Reset-Pass9" },
            admin.user,
        );
        await expect(app.verify(token)).resolves.toBeNull();
        const relogin = await app.login("erin", "Reset-Pass9");
        await expect(app.verify(relogin.token)).resolves.toEqual(user);
    });

    it("rejects short passwords", async () => {
        const app = await createTestApp({ admins: ["root"] });
        const admin = await app.register("root");
        const { user } = await app.register("frank");
        await expect(
            app.call(
                "admin.password",
                { userId: user.id, password: "123" },
                admin.user,
            ),
        ).rejects.toThrow("6 位");
    });
});
