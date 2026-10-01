import { describe, expect, it } from "vitest";
import { mustChangeBlocked } from "../src/plugins/gateway";
import type { AuditRow, AuthUser } from "../src/types";
import { createTestApp, type TestApp } from "./helpers";

const auditSetup = async () => {
    const app = await createTestApp({ admins: ["root"] });
    const root = await app.register("root");
    const vic = await app.register("vic");
    return { app, root, vic };
};

const listAudit = async (
    app: TestApp,
    actor: AuthUser,
    params: Record<string, unknown> = {},
): Promise<{ rows: AuditRow[]; total: number }> =>
    (await app.call(
        "admin.audit.list",
        { offset: 0, limit: 100, ...params },
        actor,
    )) as { rows: AuditRow[]; total: number };

describe("must change gate", () => {
    it("blocks everything except the password escape hatch", () => {
        const user: AuthUser = {
            id: "u1",
            username: "u1",
            mustChange: true,
        };
        expect(mustChangeBlocked(user, "auth.password")).toBe(false);
        expect(mustChangeBlocked(user, "auth.me")).toBe(false);
        expect(mustChangeBlocked(user, "presence.list")).toBe(false);
        expect(mustChangeBlocked(user, "presence.status")).toBe(false);
        expect(mustChangeBlocked(user, "presence.status.set")).toBe(false);
        expect(mustChangeBlocked(user, "chat.send")).toBe(true);
        expect(mustChangeBlocked(user, "org.tree")).toBe(true);
        expect(mustChangeBlocked(user, "admin.users")).toBe(true);
        expect(mustChangeBlocked(null, "chat.send")).toBe(false);
        expect(mustChangeBlocked(undefined, "chat.send")).toBe(false);
        expect(mustChangeBlocked({ id: "u", username: "u" }, "chat.send")).toBe(
            false,
        );
    });
});

describe("audit trail", () => {
    it("records register, login success and failures", async () => {
        const { app, root, vic } = await auditSetup();
        await app.login("root");
        await expect(app.login("root", "wrong-pass")).rejects.toThrow(
            "用户名或密码错误",
        );
        await expect(app.login("ghost")).rejects.toThrow("用户名或密码错误");
        await app.call(
            "auth.password",
            { oldPassword: "Passw0rd!", newPassword: "Fresh_456" },
            vic.user,
        );
        const { rows } = await listAudit(app, root.user);
        const actions = rows.map((row) => row.action);
        expect(actions).toContain("auth.register");
        expect(actions).toContain("auth.login");
        expect(actions).toContain("auth.password");
        const wrongPass = rows.find(
            (row) =>
                row.action === "auth.login.failed" && row.detail === "密码错误",
        );
        expect(wrongPass).toMatchObject({
            actor: "root",
            actorId: null,
        });
        const ghost = rows.find(
            (row) =>
                row.action === "auth.login.failed" &&
                row.detail === "用户名不存在",
        );
        expect(ghost).toMatchObject({ actor: "ghost", actorId: null });
        expect(rows.find((row) => row.action === "auth.login")?.actor).toBe(
            "root",
        );
    });

    it("records banned login attempts", async () => {
        const { app, root, vic } = await auditSetup();
        await app.call(
            "admin.ban",
            { userId: vic.user.id, on: true },
            root.user,
        );
        await expect(app.login("vic")).rejects.toThrow("封禁");
        const { rows } = await listAudit(app, root.user);
        const banned = rows.find(
            (row) =>
                row.action === "auth.login.failed" &&
                row.detail === "账号已封禁",
        );
        expect(banned).toMatchObject({ actor: "vic", actorId: vic.user.id });
    });

    it("records admin and org operations", async () => {
        const { app, root, vic } = await auditSetup();
        const dept = (await app.call(
            "admin.department.create",
            { name: "研发部" },
            root.user,
        )) as { id: string };
        await app.call(
            "admin.user.assign",
            { userId: vic.user.id, deptId: dept.id, title: "工程师" },
            root.user,
        );
        await app.call("admin.department.group", { id: dept.id }, root.user);
        await app.call(
            "admin.user.assign",
            { userId: vic.user.id, deptId: null },
            root.user,
        );
        await app.call("admin.department.delete", { id: dept.id }, root.user);
        await app.call(
            "admin.ban",
            { userId: vic.user.id, on: true },
            root.user,
        );
        await app.call(
            "admin.password",
            { userId: vic.user.id, password: "Reset_123" },
            root.user,
        );
        const { rows } = await listAudit(app, root.user);
        const actions = new Set(rows.map((row) => row.action));
        for (const action of [
            "org.dept.create",
            "org.member.assign",
            "org.dept.group",
            "org.dept.delete",
            "admin.ban",
            "admin.password",
        ])
            expect(actions.has(action), action).toBe(true);
        const assign = rows.find(
            (row) =>
                row.action === "org.member.assign" &&
                row.detail.includes("研发部"),
        );
        expect(assign?.actor).toBe("root");
        expect(assign?.detail).toContain("工程师");
        expect(
            rows.find((row) => row.action === "org.dept.delete")?.detail,
        ).toContain("研发部");
    });

    it("filters by category and keyword, paginating results", async () => {
        const { app, root, vic } = await auditSetup();
        await app.login("root");
        const dept = (await app.call(
            "admin.department.create",
            { name: "审计部" },
            root.user,
        )) as { id: string };
        await app.call(
            "admin.user.assign",
            { userId: vic.user.id, deptId: dept.id, title: "审计员" },
            root.user,
        );
        await app.call(
            "admin.register.set",
            { allowRegister: true },
            root.user,
        );

        const auth = await listAudit(app, root.user, { category: "auth" });
        expect(auth.total).toBeGreaterThan(0);
        expect(auth.rows.every((row) => row.action.startsWith("auth."))).toBe(
            true,
        );
        const org = await listAudit(app, root.user, { category: "org" });
        expect(org.total).toBeGreaterThanOrEqual(2);
        expect(org.rows.every((row) => row.action.startsWith("org."))).toBe(
            true,
        );
        const admin = await listAudit(app, root.user, { category: "admin" });
        expect(admin.total).toBeGreaterThanOrEqual(1);
        expect(admin.rows.every((row) => row.action.startsWith("admin."))).toBe(
            true,
        );
        const unknown = await listAudit(app, root.user, { category: "nope" });
        expect(unknown.total).toBe(auth.total + org.total + admin.total);

        const keyword = await listAudit(app, root.user, { keyword: "审计部" });
        expect(keyword.total).toBeGreaterThanOrEqual(1);
        expect(keyword.rows.every((row) => row.detail.includes("审计部"))).toBe(
            true,
        );
        const byActor = await listAudit(app, root.user, { keyword: "vic" });
        expect(byActor.rows.some((row) => row.actor === "vic")).toBe(true);

        const first = await listAudit(app, root.user, { limit: 2, offset: 0 });
        expect(first.rows).toHaveLength(2);
        const second = await listAudit(app, root.user, { limit: 2, offset: 2 });
        expect(second.rows).toHaveLength(2);
        expect(first.total).toBe(second.total);
        const past = await listAudit(app, root.user, { limit: 2, offset: 999 });
        expect(past.rows).toHaveLength(0);
        expect(past.total).toBe(first.total);
        const ids = new Set([...first.rows, ...second.rows].map((r) => r.id));
        expect(ids.size).toBe(4);
    });

    it("restricts the log to admins", async () => {
        const { app, vic } = await auditSetup();
        await expect(
            app.call("admin.audit.list", {}, vic.user),
        ).rejects.toThrow("管理员");
        await expect(
            app.call("admin.register.get", {}, vic.user),
        ).rejects.toThrow("管理员");
        await expect(
            app.call("admin.register.set", { allowRegister: false }, vic.user),
        ).rejects.toThrow("管理员");
    });

    it("returns well-formed rows", async () => {
        const { app, root } = await auditSetup();
        const { rows } = await listAudit(app, root.user);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.id).toBeTruthy();
            expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
        }
    });
});
