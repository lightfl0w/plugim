import type { Plugin } from "@plugim/core";
import type {
    AccountsStore,
    AuditService,
    AuthUser,
    ConnInfo,
    DepartmentRow,
    DepartmentsStore,
    GatewayService,
    GroupsStore,
} from "../types";
import { requireAdmin } from "./admin";

const MAX_DEPTH = 5;
const NAME_LIMIT = 30;
const TITLE_LIMIT = 20;

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const chainDepth = (rows: DepartmentRow[], id: string | null): number => {
    let depth = 0;
    let current = id ? (rows.find((row) => row.id === id) ?? null) : null;
    while (current) {
        depth += 1;
        const parentId: string | null = current.parentId;
        current = parentId
            ? (rows.find((row) => row.id === parentId) ?? null)
            : null;
        if (depth > 32) break;
    }
    return depth;
};

const descendantsOf = (rows: DepartmentRow[], id: string): Set<string> => {
    const out = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        for (const row of rows) {
            if (row.parentId !== current || out.has(row.id)) continue;
            out.add(row.id);
            queue.push(row.id);
        }
    }
    return out;
};

const subtreeHeight = (rows: DepartmentRow[], id: string): number => {
    let height = 0;
    const walk = (currentId: string, level: number) => {
        if (level > height) height = level;
        for (const row of rows) {
            if (row.parentId === currentId) walk(row.id, level + 1);
        }
    };
    walk(id, 1);
    return height;
};

const cleanName = (raw: unknown): string => {
    const name = String(raw ?? "")
        .trim()
        .slice(0, NAME_LIMIT);
    if (!name) throw new Error("请输入部门名称");
    return name;
};

export const orgPlugin: Plugin = {
    name: "org",
    description: "组织架构与企业通讯录",
    provides: ["org"],
    inject: ["gateway", "accounts", "groups", "departments", "audit"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const groups = ctx.get<GroupsStore>("groups");
        const departments = ctx.get<DepartmentsStore>("departments");
        const audit = ctx.get<AuditService>("audit");

        const treeData = async () => {
            const [rows, counts] = await Promise.all([
                departments.listAll(),
                departments.memberCounts(),
            ]);
            return rows.map((row) => ({
                id: row.id,
                name: row.name,
                parentId: row.parentId,
                sort: row.sort,
                groupId: row.groupId,
                memberCount: counts[row.id] ?? 0,
                createdAt: row.createdAt,
            }));
        };

        const deptOf = async (id: string | null) =>
            id ? await departments.byId(id) : null;

        const siblingClash = (
            rows: DepartmentRow[],
            parentId: string | null,
            name: string,
            excludeId?: string,
        ) =>
            rows.some(
                (row) =>
                    row.parentId === parentId &&
                    row.name === name &&
                    row.id !== excludeId,
            );

        const notifyGroup = async (groupId: string) => {
            const ids = await groups.memberIdsOf(groupId);
            for (const userId of ids)
                gateway.emitToUser(userId, "group:update", { groupId });
        };

        gateway.rpc("org.tree", async (_raw, conn) => {
            requireUser(conn);
            return treeData();
        });

        gateway.rpc("org.directory", async (_raw, conn) => {
            requireUser(conn);
            const [departmentsList, users] = await Promise.all([
                treeData(),
                accounts.listAll(),
            ]);
            const online = new Set(gateway.onlineUserIds());
            return {
                departments: departmentsList,
                members: users
                    .filter((user) => !user.banned)
                    .map((user) => ({
                        id: user.id,
                        username: user.username,
                        deptId: user.deptId,
                        title: user.title,
                        createdAt: user.createdAt,
                        online: online.has(user.id),
                    })),
            };
        });

        gateway.rpc("admin.department.create", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                name?: unknown;
                parentId?: unknown;
            };
            const name = cleanName(params.name);
            const parentId = params.parentId ? String(params.parentId) : null;
            const rows = await departments.listAll();
            if (parentId && !rows.some((row) => row.id === parentId))
                throw new Error("上级部门不存在");
            if (chainDepth(rows, parentId) >= MAX_DEPTH)
                throw new Error(`部门层级不能超过 ${MAX_DEPTH} 级`);
            if (siblingClash(rows, parentId, name))
                throw new Error("同级已存在同名部门");
            const row = await departments.create(name, parentId);
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "org.dept.create",
                detail: `新建部门「${name}」`,
            });
            return row;
        });

        gateway.rpc("admin.department.rename", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                id?: unknown;
                name?: unknown;
            };
            const id = String(params.id ?? "");
            const name = cleanName(params.name);
            const rows = await departments.listAll();
            const row = rows.find((item) => item.id === id);
            if (!row) throw new Error("部门不存在");
            if (siblingClash(rows, row.parentId, name, id))
                throw new Error("同级已存在同名部门");
            await departments.rename(id, name);
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "org.dept.rename",
                detail: `部门「${row.name}」更名为「${name}」`,
            });
            return true;
        });

        gateway.rpc("admin.department.move", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                id?: unknown;
                parentId?: unknown;
            };
            const id = String(params.id ?? "");
            const parentId = params.parentId ? String(params.parentId) : null;
            const rows = await departments.listAll();
            const row = rows.find((item) => item.id === id);
            if (!row) throw new Error("部门不存在");
            if (parentId === id) throw new Error("不能移动到自身");
            let parent: DepartmentRow | null = null;
            if (parentId) {
                parent = rows.find((item) => item.id === parentId) ?? null;
                if (!parent) throw new Error("目标部门不存在");
                if (descendantsOf(rows, id).has(parentId))
                    throw new Error("不能移动到自己的子部门");
                if (
                    chainDepth(rows, parentId) + subtreeHeight(rows, id) >
                    MAX_DEPTH
                )
                    throw new Error(`部门层级不能超过 ${MAX_DEPTH} 级`);
            }
            if (siblingClash(rows, parentId, row.name, id))
                throw new Error("目标部门下已存在同名部门");
            await departments.move(id, parentId);
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "org.dept.move",
                detail: parent
                    ? `部门「${row.name}」移入「${parent.name}」`
                    : `部门「${row.name}」移动到根级`,
            });
            return true;
        });

        gateway.rpc("admin.department.delete", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const id = String((raw as { id?: unknown }).id ?? "");
            const rows = await departments.listAll();
            const row = rows.find((item) => item.id === id);
            if (!row) throw new Error("部门不存在");
            if (rows.some((item) => item.parentId === id))
                throw new Error("请先删除或移走子部门");
            const users = await accounts.listAll();
            if (users.some((user) => user.deptId === id))
                throw new Error("部门内仍有成员，请先转移成员");
            await departments.remove(id);
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "org.dept.delete",
                detail: `删除部门「${row.name}」`,
            });
            return true;
        });

        gateway.rpc("admin.user.assign", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                userId?: unknown;
                deptId?: unknown;
                title?: unknown;
            };
            const userId = String(params.userId ?? "");
            const row = await accounts.fullById(userId);
            if (!row) throw new Error("用户不存在");
            const deptId = params.deptId ? String(params.deptId) : null;
            const dept = await deptOf(deptId);
            if (deptId && !dept) throw new Error("部门不存在");
            const title =
                String(params.title ?? "")
                    .trim()
                    .slice(0, TITLE_LIMIT) || null;
            await accounts.setOrg(userId, deptId, title);
            const scope = dept ? `调入「${dept.name}」` : "移出部门";
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "org.member.assign",
                detail: `将 ${row.username} ${scope}${title ? `，职位「${title}」` : ""}`,
            });
            return true;
        });

        gateway.rpc("admin.department.group", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const id = String((raw as { id?: unknown }).id ?? "");
            const rows = await departments.listAll();
            const row = rows.find((item) => item.id === id);
            if (!row) throw new Error("部门不存在");
            if (row.groupId) {
                const existing = await groups.byId(row.groupId);
                if (existing) return { groupId: row.groupId, created: false };
            }
            const scope = new Set([row.id, ...descendantsOf(rows, row.id)]);
            const users = await accounts.listAll();
            const group = await groups.create(`${row.name}群`, me.id);
            await groups.addMember(group.id, me.id);
            await groups.setRole(group.id, me.id, "owner");
            for (const user of users) {
                if (user.id === me.id || user.banned) continue;
                if (!user.deptId || !scope.has(user.deptId)) continue;
                await groups.addMember(group.id, user.id);
            }
            await departments.setGroup(row.id, group.id);
            await notifyGroup(group.id);
            await audit.log({
                actorId: me.id,
                actor: me.username,
                action: "org.dept.group",
                detail: `为部门「${row.name}」创建部门群`,
            });
            return { groupId: group.id, created: true };
        });

        gateway.rpc("admin.department.group.sync", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const id = String((raw as { id?: unknown }).id ?? "");
            const rows = await departments.listAll();
            const row = rows.find((item) => item.id === id);
            if (!row) throw new Error("部门不存在");
            if (!row.groupId) throw new Error("该部门还没有部门群");
            const group = await groups.byId(row.groupId);
            if (!group) throw new Error("部门群已不存在");
            const scope = new Set([row.id, ...descendantsOf(rows, row.id)]);
            const users = await accounts.listAll();
            const members = new Set(await groups.memberIdsOf(group.id));
            let added = 0;
            for (const user of users) {
                if (user.banned || members.has(user.id)) continue;
                if (!user.deptId || !scope.has(user.deptId)) continue;
                await groups.addMember(group.id, user.id);
                added += 1;
            }
            if (added > 0) {
                await notifyGroup(group.id);
                await audit.log({
                    actorId: me.id,
                    actor: me.username,
                    action: "org.dept.group",
                    detail: `部门「${row.name}」群同步加入 ${added} 名成员`,
                });
            }
            return { added };
        });

        return undefined;
    },
};
