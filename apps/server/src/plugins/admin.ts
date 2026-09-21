import type { Plugin } from "@plugim/core";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    GatewayService,
    GroupsStore,
} from "../types";

const requireAdmin = async (
    conn: ConnInfo,
    accounts: AccountsStore,
): Promise<AuthUser> => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    const row = await accounts.fullById(conn.user.id);
    if (!row?.isAdmin) throw new Error("需要管理员权限");
    return conn.user;
};

export const adminPlugin: Plugin = {
    name: "admin",
    description: "后台管理 RPC",
    provides: ["admin-rpc"],
    inject: ["gateway", "accounts", "groups"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const groups = ctx.get<GroupsStore>("groups");

        gateway.rpc("admin.users", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            const users = await accounts.listAll();
            const online = new Set(gateway.onlineUserIds());
            return users.map((user) => ({
                ...user,
                online: online.has(user.id),
            }));
        });

        gateway.rpc("admin.ban", async (raw, conn) => {
            const me = await requireAdmin(conn, accounts);
            const { userId, on } = raw as unknown as {
                userId: string;
                on: boolean;
            };
            if (userId === me.id) throw new Error("不能封禁自己");
            await accounts.setFlag(userId, "banned", !!on);
            if (on) gateway.kickUser(userId);
            return true;
        });

        gateway.rpc("admin.grant", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const { userId, on } = raw as unknown as {
                userId: string;
                on: boolean;
            };
            await accounts.setFlag(userId, "isAdmin", !!on);
            return true;
        });

        gateway.rpc("admin.groups", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            const rows = await groups.listAll();
            const names = await accounts.byIds(rows.map((row) => row.ownerId));
            const nameById = new Map(
                names.map((row) => [row.id, row.username]),
            );
            return rows.map((row) => ({
                ...row,
                ownerName: nameById.get(row.ownerId) ?? row.ownerId,
            }));
        });

        gateway.rpc("admin.group.delete", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const { groupId } = raw as unknown as { groupId: string };
            await groups.remove(groupId);
            return true;
        });

        gateway.rpc("admin.stats", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            const [userCount, groupRows] = await Promise.all([
                accounts.count(),
                groups.listAll(),
            ]);
            return {
                users: userCount,
                groups: groupRows.length,
                connections: gateway.connections(),
            };
        });
        return undefined;
    },
};
