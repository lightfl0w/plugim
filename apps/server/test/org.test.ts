import { describe, expect, it } from "vitest";
import { mustChangeBlocked } from "../src/plugins/gateway";
import type { AccountsStore, AuthUser } from "../src/types";
import { createTestApp, type TestApp } from "./helpers";

interface DeptRow {
    id: string;
    name: string;
    parentId: string | null;
    groupId: string | null;
}

interface DeptNode extends DeptRow {
    memberCount: number;
}

type Session = { user: AuthUser; token: string };

const orgSetup = async () => {
    const app = await createTestApp({ admins: ["root"] });
    const root = await app.register("root");
    const alice = await app.register("alice");
    const bob = await app.register("bob");
    return { app, root, alice, bob };
};

const createDept = (
    app: TestApp,
    actor: Session,
    name: string,
    parentId?: string,
) =>
    app.call(
        "admin.department.create",
        { name, parentId },
        actor.user,
    ) as Promise<DeptRow>;

const treeOf = (app: TestApp, actor: Session) =>
    app.call("org.tree", {}, actor.user) as Promise<DeptNode[]>;

describe("org rpc", () => {
    it("rejects anonymous and non-admin callers", async () => {
        const { app, alice } = await orgSetup();
        await expect(app.call("org.tree")).rejects.toThrow("未登录");
        await expect(app.call("org.directory")).rejects.toThrow("未登录");
        for (const method of [
            "admin.department.create",
            "admin.department.rename",
            "admin.department.move",
            "admin.department.delete",
            "admin.department.group",
            "admin.department.group.sync",
            "admin.user.assign",
            "admin.user.create",
        ]) {
            await expect(
                app.call(method, { name: "x", id: "y" }, alice.user),
            ).rejects.toThrow("管理员");
        }
    });

    it("creates and renames departments with sibling checks", async () => {
        const { app, root } = await orgSetup();
        const dev = await createDept(app, root, " 研发部 ");
        expect(dev.name).toBe("研发部");
        expect(dev.parentId).toBeNull();
        const front = await createDept(app, root, "前端组", dev.id);
        expect(front.parentId).toBe(dev.id);

        const tree = await treeOf(app, root);
        expect(tree.map((row) => row.name).sort()).toEqual(
            ["研发部", "前端组"].sort(),
        );
        expect(tree.find((row) => row.id === dev.id)?.memberCount).toBe(0);

        await expect(createDept(app, root, "研发部")).rejects.toThrow(
            "同级已存在同名部门",
        );
        await expect(
            app.call("admin.department.create", { name: "   " }, root.user),
        ).rejects.toThrow("请输入部门名称");
        await expect(
            app.call(
                "admin.department.create",
                { name: "产品部", parentId: "nope" },
                root.user,
            ),
        ).rejects.toThrow("上级部门不存在");

        const market = await createDept(app, root, "市场部");
        await expect(
            app.call(
                "admin.department.rename",
                { id: market.id, name: "研发部" },
                root.user,
            ),
        ).rejects.toThrow("同级已存在同名部门");
        await app.call(
            "admin.department.rename",
            { id: front.id, name: "前端研发组" },
            root.user,
        );
        const renamed = await treeOf(app, root);
        expect(renamed.find((row) => row.id === front.id)?.name).toBe(
            "前端研发组",
        );
        await expect(
            app.call(
                "admin.department.rename",
                { id: "nope", name: "任意" },
                root.user,
            ),
        ).rejects.toThrow("部门不存在");
    });

    it("limits the tree to five levels", async () => {
        const { app, root } = await orgSetup();
        let parent: string | undefined;
        for (let level = 1; level <= 5; level += 1) {
            const node = await createDept(app, root, `L${level}`, parent);
            parent = node.id;
        }
        await expect(createDept(app, root, "L6", parent)).rejects.toThrow(
            "部门层级不能超过 5 级",
        );
        expect(await treeOf(app, root)).toHaveLength(5);
    });

    it("prevents cycles and depth overflow when moving", async () => {
        const { app, root } = await orgSetup();
        const a = await createDept(app, root, "A");
        const b = await createDept(app, root, "B", a.id);
        await expect(
            app.call(
                "admin.department.move",
                { id: a.id, parentId: a.id },
                root.user,
            ),
        ).rejects.toThrow("不能移动到自身");
        await expect(
            app.call(
                "admin.department.move",
                { id: a.id, parentId: b.id },
                root.user,
            ),
        ).rejects.toThrow("不能移动到自己的子部门");
        await expect(
            app.call(
                "admin.department.move",
                { id: a.id, parentId: "nope" },
                root.user,
            ),
        ).rejects.toThrow("目标部门不存在");

        const chain: DeptRow[] = [await createDept(app, root, "C1")];
        for (let level = 2; level <= 4; level += 1)
            chain.push(
                await createDept(app, root, `C${level}`, chain[level - 2].id),
            );
        const deepest = await createDept(app, root, "C5", chain[3].id);
        const sub = await createDept(app, root, "S1");
        const subChild = await createDept(app, root, "S2", sub.id);
        await expect(
            app.call(
                "admin.department.move",
                { id: sub.id, parentId: deepest.id },
                root.user,
            ),
        ).rejects.toThrow("部门层级不能超过 5 级");
        await app.call(
            "admin.department.move",
            { id: sub.id, parentId: chain[2].id },
            root.user,
        );
        const moved = await treeOf(app, root);
        expect(moved.find((row) => row.id === sub.id)?.parentId).toBe(
            chain[2].id,
        );
        expect(moved.find((row) => row.id === subChild.id)?.parentId).toBe(
            sub.id,
        );

        const room = await createDept(app, root, "会议室");
        await createDept(app, root, "茶水间", room.id);
        const stray = await createDept(app, root, "茶水间");
        await expect(
            app.call(
                "admin.department.move",
                { id: stray.id, parentId: room.id },
                root.user,
            ),
        ).rejects.toThrow("目标部门下已存在同名部门");
    });

    it("blocks deleting departments with children or members", async () => {
        const { app, root, alice } = await orgSetup();
        const dev = await createDept(app, root, "研发部");
        const front = await createDept(app, root, "前端组", dev.id);
        await expect(
            app.call("admin.department.delete", { id: dev.id }, root.user),
        ).rejects.toThrow("请先删除或移走子部门");
        await app.call(
            "admin.user.assign",
            { userId: alice.user.id, deptId: front.id, title: "工程师" },
            root.user,
        );
        await expect(
            app.call("admin.department.delete", { id: front.id }, root.user),
        ).rejects.toThrow("部门内仍有成员");
        await app.call(
            "admin.user.assign",
            { userId: alice.user.id, deptId: null },
            root.user,
        );
        await app.call("admin.department.delete", { id: front.id }, root.user);
        const tree = await treeOf(app, root);
        expect(tree.some((row) => row.id === front.id)).toBe(false);
        await expect(
            app.call("admin.department.delete", { id: "nope" }, root.user),
        ).rejects.toThrow("部门不存在");
    });

    it("assigns departments and titles to members", async () => {
        const { app, root, alice } = await orgSetup();
        const dev = await createDept(app, root, "研发部");
        await app.call(
            "admin.user.assign",
            { userId: alice.user.id, deptId: dev.id, title: " 高级工程师 " },
            root.user,
        );
        const info = (await app.call(
            "user.info",
            { username: "alice" },
            alice.user,
        )) as {
            deptId: string | null;
            title: string | null;
            deptName: string | null;
        };
        expect(info).toMatchObject({
            deptId: dev.id,
            title: "高级工程师",
            deptName: "研发部",
        });
        const tree = await treeOf(app, root);
        expect(tree.find((row) => row.id === dev.id)?.memberCount).toBe(1);
        const users = (await app.call("admin.users", {}, root.user)) as {
            username: string;
            deptId: string | null;
            title: string | null;
        }[];
        expect(users.find((row) => row.username === "alice")).toMatchObject({
            deptId: dev.id,
            title: "高级工程师",
        });

        await expect(
            app.call(
                "admin.user.assign",
                { userId: "nope", deptId: dev.id },
                root.user,
            ),
        ).rejects.toThrow("用户不存在");
        await expect(
            app.call(
                "admin.user.assign",
                { userId: alice.user.id, deptId: "nope" },
                root.user,
            ),
        ).rejects.toThrow("部门不存在");

        await app.call(
            "admin.user.assign",
            {
                userId: alice.user.id,
                deptId: dev.id,
                title: "职".repeat(30),
            },
            root.user,
        );
        const truncated = (await app.call("admin.users", {}, root.user)) as {
            username: string;
            title: string | null;
        }[];
        expect(
            truncated.find((row) => row.username === "alice")?.title,
        ).toHaveLength(20);

        await app.call(
            "admin.user.assign",
            { userId: alice.user.id, deptId: null },
            root.user,
        );
        const cleared = (await app.call(
            "user.info",
            { username: "alice" },
            alice.user,
        )) as { deptId: string | null; title: string | null };
        expect(cleared).toMatchObject({ deptId: null, title: null });
    });

    it("serves a directory with online flags and hides banned users", async () => {
        const { app, root, alice, bob } = await orgSetup();
        const dev = await createDept(app, root, "研发部");
        await app.call(
            "admin.user.assign",
            { userId: alice.user.id, deptId: dev.id, title: "工程师" },
            root.user,
        );
        app.setOnline(alice.user);
        const dir = (await app.call("org.directory", {}, bob.user)) as {
            departments: DeptNode[];
            members: {
                username: string;
                deptId: string | null;
                title: string | null;
                online: boolean;
            }[];
        };
        expect(dir.members.find((m) => m.username === "alice")).toMatchObject({
            deptId: dev.id,
            title: "工程师",
            online: true,
        });
        expect(dir.members.find((m) => m.username === "bob")?.online).toBe(
            false,
        );
        expect(dir.departments.some((row) => row.id === dev.id)).toBe(true);
        await app.call(
            "admin.ban",
            { userId: bob.user.id, on: true },
            root.user,
        );
        const hidden = (await app.call("org.directory", {}, alice.user)) as {
            members: { username: string }[];
        };
        expect(hidden.members.some((m) => m.username === "bob")).toBe(false);
    });

    it("creates a department group over the subtree and syncs members", async () => {
        const { app, root, alice, bob } = await orgSetup();
        const dev = await createDept(app, root, "研发部");
        const front = await createDept(app, root, "前端组", dev.id);
        await app.call(
            "admin.user.assign",
            { userId: alice.user.id, deptId: dev.id },
            root.user,
        );
        await app.call(
            "admin.user.assign",
            { userId: bob.user.id, deptId: front.id },
            root.user,
        );
        const carol = await app.register("carol");
        const created = (await app.call(
            "admin.department.group",
            { id: dev.id },
            root.user,
        )) as { groupId: string; created: boolean };
        expect(created.created).toBe(true);
        const again = (await app.call(
            "admin.department.group",
            { id: dev.id },
            root.user,
        )) as { groupId: string; created: boolean };
        expect(again).toEqual({ groupId: created.groupId, created: false });

        const groups = (await app.call("admin.groups", {}, root.user)) as {
            id: string;
            name: string;
            memberCount: number;
            ownerName: string;
        }[];
        expect(groups.find((row) => row.id === created.groupId)).toMatchObject({
            name: "研发部群",
            memberCount: 3,
            ownerName: "root",
        });

        await app.call(
            "admin.user.assign",
            { userId: carol.user.id, deptId: front.id },
            root.user,
        );
        const synced = (await app.call(
            "admin.department.group.sync",
            { id: dev.id },
            root.user,
        )) as { added: number };
        expect(synced.added).toBe(1);
        const resynced = (await app.call(
            "admin.department.group.sync",
            { id: dev.id },
            root.user,
        )) as { added: number };
        expect(resynced.added).toBe(0);
        const groupsAfter = (await app.call("admin.groups", {}, root.user)) as {
            id: string;
            memberCount: number;
        }[];
        expect(
            groupsAfter.find((row) => row.id === created.groupId)?.memberCount,
        ).toBe(4);

        await expect(
            app.call(
                "admin.department.group.sync",
                { id: front.id },
                root.user,
            ),
        ).rejects.toThrow("该部门还没有部门群");
    });

    it("provisions accounts with a forced password change", async () => {
        const { app, root } = await orgSetup();
        const dev = await createDept(app, root, "研发部");
        const created = (await app.call(
            "admin.user.create",
            {
                username: "NewHire",
                password: "Init_123",
                deptId: dev.id,
                title: "实习生",
            },
            root.user,
        )) as { id: string; username: string };
        expect(created.username).toBe("newhire");
        const row = await app.ctx
            .get<AccountsStore>("accounts")
            .fullById(created.id);
        expect(row).toMatchObject({
            deptId: dev.id,
            title: "实习生",
            mustChangePassword: true,
        });

        await expect(
            app.call(
                "admin.user.create",
                { username: "newhire", password: "Init_123" },
                root.user,
            ),
        ).rejects.toThrow("用户名已被占用");
        await expect(
            app.call(
                "admin.user.create",
                { username: "x", password: "Init_123" },
                root.user,
            ),
        ).rejects.toThrow("用户名需为");
        await expect(
            app.call(
                "admin.user.create",
                { username: "goodname", password: "123" },
                root.user,
            ),
        ).rejects.toThrow("密码至少需要 6 位");
        await expect(
            app.call(
                "admin.user.create",
                { username: "goodname", password: "Init_123", deptId: "nope" },
                root.user,
            ),
        ).rejects.toThrow("部门不存在");

        const login = await app.login("newhire", "Init_123");
        const verified = await app.verify(login.token);
        expect(verified?.mustChange).toBe(true);
        expect(mustChangeBlocked(verified, "chat.send")).toBe(true);
        expect(mustChangeBlocked(verified, "auth.me")).toBe(false);
        const changed = (await app.call(
            "auth.password",
            { oldPassword: "Init_123", newPassword: "Fresh_456" },
            verified,
        )) as { token: string };
        const after = await app.verify(changed.token);
        expect(after?.mustChange).toBe(false);
        expect(mustChangeBlocked(after, "chat.send")).toBe(false);
        const relogin = await app.login("newhire", "Fresh_456");
        expect(relogin.user.id).toBe(created.id);
    });

    it("lets admins close registration or require an invite code", async () => {
        const { app, root } = await orgSetup();
        const policy = await app.call("admin.register.get", {}, root.user);
        expect(policy).toEqual({ allowRegister: true, inviteCode: "" });
        await app.call(
            "admin.register.set",
            { allowRegister: false, inviteCode: "" },
            root.user,
        );
        await expect(app.register("stranger")).rejects.toThrow("已关闭注册");
        await app.call(
            "admin.register.set",
            { inviteCode: "s3cret" },
            root.user,
        );
        await expect(app.register("stranger")).rejects.toThrow(
            "邀请码错误或未填写",
        );
        await app.call("auth.register", {
            username: "stranger",
            password: "Passw0rd!",
            inviteCode: "s3cret",
        });
        const users = (await app.call("admin.users", {}, root.user)) as {
            username: string;
        }[];
        expect(users.some((row) => row.username === "stranger")).toBe(true);
    });
});
