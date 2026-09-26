import type { Plugin } from "@plugim/core";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    GatewayService,
    GroupsStore,
    MessageStore,
    SettingsStore,
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

const RETENTION_KEY = "message_retention_days";
const DAY_MS = 86_400_000;

export const adminPlugin: Plugin = {
    name: "admin",
    description: "后台管理 RPC",
    provides: ["admin-rpc"],
    inject: ["gateway", "accounts", "groups", "store", "settings"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const groups = ctx.get<GroupsStore>("groups");
        const store = ctx.get<MessageStore>("store");
        const settings = ctx.get<SettingsStore>("settings");

        const retentionDays = async () => {
            const raw = await settings.get(RETENTION_KEY);
            const days = Number(raw);
            return Number.isInteger(days) && days > 0 ? days : 0;
        };
        const runCleanup = async () => {
            const days = await retentionDays();
            if (!days) return 0;
            return store.deleteOlderThan(
                new Date(Date.now() - days * DAY_MS).toISOString(),
            );
        };

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

        gateway.rpc("admin.messages", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                keyword?: string;
                session?: string;
                sender?: string;
                offset?: number;
                limit?: number;
            };
            return store.search({
                keyword: params.keyword?.slice(0, 100) || undefined,
                session: params.session?.slice(0, 200) || undefined,
                sender: params.sender?.slice(0, 64) || undefined,
                offset: Math.max(0, Number(params.offset) || 0),
                limit: Math.min(Math.max(Number(params.limit) || 20, 1), 100),
            });
        });

        gateway.rpc("admin.files", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                offset?: number;
                limit?: number;
            };
            const result = await store.search({
                media: true,
                offset: Math.max(0, Number(params.offset) || 0),
                limit: Math.min(Math.max(Number(params.limit) || 20, 1), 100),
            });
            return {
                ...result,
                totalBytes: await store.mediaBytes(),
            };
        });

        gateway.rpc("admin.retention.get", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            return { days: await retentionDays() };
        });

        gateway.rpc("admin.retention.set", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const { days } = raw as unknown as { days: number };
            const value = Number(days);
            if (!Number.isInteger(value) || value < 0 || value > 3650)
                throw new Error("保留天数需为 0 到 3650 之间的整数");
            await settings.set(RETENTION_KEY, String(value));
            return { days: value };
        });

        gateway.rpc("admin.cleanup", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            const days = await retentionDays();
            if (!days) throw new Error("尚未设置保留天数");
            return { deleted: await runCleanup() };
        });

        gateway.rpc("admin.stats", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            const [userCount, groupRows, messageCount, mediaBytes] =
                await Promise.all([
                    accounts.count(),
                    groups.listAll(),
                    store.count(),
                    store.mediaBytes(),
                ]);
            return {
                users: userCount,
                groups: groupRows.length,
                connections: gateway.connections(),
                messages: messageCount,
                mediaBytes,
                retentionDays: await retentionDays(),
            };
        });

        const cleanupTimer = setInterval(
            () => void runCleanup().catch(() => {}),
            DAY_MS,
        );
        cleanupTimer.unref?.();
        const startupTimer = setTimeout(
            () => void runCleanup().catch(() => {}),
            5_000,
        );
        startupTimer.unref?.();
        return () => {
            clearInterval(cleanupTimer);
            clearTimeout(startupTimer);
        };
    },
};
