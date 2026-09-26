import type { Plugin } from "@plugim/core";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    GatewayService,
    GroupFilesStore,
    GroupsStore,
    MediaFileRow,
    MediaFilesStore,
    MessageStore,
    SettingsStore,
} from "../types";
import type { FileService } from "./files";
import type { TasksService } from "./tasks";

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
const FILE_KEY_RE = /^\/files\/([a-f0-9]{32})$/;

export const adminPlugin: Plugin = {
    name: "admin",
    description: "后台管理 RPC",
    provides: ["admin-rpc"],
    inject: [
        "gateway",
        "accounts",
        "groups",
        "store",
        "settings",
        "files",
        "mediaFiles",
        "groupFiles",
        "tasks",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const groups = ctx.get<GroupsStore>("groups");
        const store = ctx.get<MessageStore>("store");
        const settings = ctx.get<SettingsStore>("settings");
        const files = ctx.get<FileService>("files");
        const mediaFiles = ctx.get<MediaFilesStore>("mediaFiles");
        const groupFiles = ctx.get<GroupFilesStore>("groupFiles");
        const tasks = ctx.get<TasksService>("tasks");

        const retentionDays = async () => {
            const raw = await settings.get(RETENTION_KEY);
            const days = Number(raw);
            return Number.isInteger(days) && days > 0 ? days : 0;
        };

        const pruneMedia = async (candidates: MediaFileRow[]) => {
            let removed = 0;
            for (const row of candidates) {
                if (await store.countByContent(files.url(row.key))) continue;
                if (await groupFiles.countByKey(row.key)) continue;
                await files.remove(row.key);
                await mediaFiles.remove(row.key);
                removed += 1;
            }
            return removed;
        };

        const runCleanup = async () => {
            const days = await retentionDays();
            if (!days) return { deleted: 0, files: 0 };
            const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
            const messages = await store.deleteOlderThan(cutoff);
            const keys = new Set<string>();
            for (const message of messages) {
                const key = FILE_KEY_RE.exec(message.content)?.[1];
                if (key) keys.add(key);
            }
            const orphans = await mediaFiles.olderThan(cutoff);
            const byKey = new Map(orphans.map((row) => [row.key, row]));
            for (const key of keys) {
                if (byKey.has(key)) continue;
                const row = await mediaFiles.byKey(key);
                if (row) byKey.set(key, row);
            }
            return {
                deleted: messages.length,
                files: await pruneMedia([...byKey.values()]),
            };
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
            const result = await mediaFiles.list({
                offset: Math.max(0, Number(params.offset) || 0),
                limit: Math.min(Math.max(Number(params.limit) || 20, 1), 100),
            });
            const uploaders = await accounts.byIds(
                result.rows.map((row) => row.uploaderId),
            );
            const nameById = new Map(
                uploaders.map((row) => [row.id, row.username]),
            );
            return {
                rows: result.rows.map((row) => ({
                    ...row,
                    uploaderName:
                        nameById.get(row.uploaderId) ?? row.uploaderId,
                })),
                total: result.total,
                totalBytes: await mediaFiles.totalBytes(),
            };
        });

        gateway.rpc("admin.files.delete", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const { key } = raw as unknown as { key: string };
            if (!/^[a-f0-9]{32}$/.test(String(key ?? "")))
                throw new Error("文件不存在");
            const row = await mediaFiles.byKey(key);
            if (!row) throw new Error("文件不存在");
            if (await store.countByContent(files.url(key)))
                throw new Error("该文件仍被消息引用，请先删除相关消息");
            if (await groupFiles.countByKey(key))
                throw new Error("该文件仍被群文件引用，请先删除群文件");
            await files.remove(key);
            await mediaFiles.remove(key);
            return true;
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
            return runCleanup();
        });

        gateway.rpc("admin.stats", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            const [userCount, groupRows, messageCount, fileBytes, inlineBytes] =
                await Promise.all([
                    accounts.count(),
                    groups.listAll(),
                    store.count(),
                    mediaFiles.totalBytes(),
                    store.mediaBytes(),
                ]);
            return {
                users: userCount,
                groups: groupRows.length,
                connections: gateway.connections(),
                messages: messageCount,
                mediaBytes: fileBytes + inlineBytes,
                files: await mediaFiles.count(),
                retentionDays: await retentionDays(),
            };
        });

        gateway.rpc("admin.trend", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const days = Number((raw as { days?: number }).days) || 14;
            const points = await store.trend(days);
            return { days: points.length, points };
        });

        gateway.rpc("admin.tasks", async (_raw, conn) => {
            await requireAdmin(conn, accounts);
            return tasks.list();
        });

        gateway.rpc("admin.task.run", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const { name } = raw as unknown as { name: string };
            return tasks.run(String(name ?? ""));
        });

        gateway.rpc("admin.task.set", async (raw, conn) => {
            await requireAdmin(conn, accounts);
            const params = raw as unknown as {
                name: string;
                enabled?: boolean;
                intervalMinutes?: number;
            };
            return tasks.set(String(params.name ?? ""), {
                enabled:
                    params.enabled === undefined ? undefined : !!params.enabled,
                intervalMinutes:
                    params.intervalMinutes === undefined
                        ? undefined
                        : Number(params.intervalMinutes),
            });
        });

        tasks.register({
            name: "message-cleanup",
            title: "过期消息清理",
            description: "按保留天数删除历史消息，并清理不再被引用的媒体文件",
            intervalMinutes: 1440,
            run: async () => {
                const days = await retentionDays();
                if (!days) return "未设置保留天数，跳过";
                const result = await runCleanup();
                return `删除 ${result.deleted} 条消息、${result.files} 个文件`;
            },
        });

        tasks.register({
            name: "media-sweep",
            title: "孤儿文件清理",
            description: "删除上传后 24 小时内未被任何消息引用或转发引用的文件",
            intervalMinutes: 1440,
            run: async () => {
                const cutoff = new Date(Date.now() - DAY_MS).toISOString();
                const rows = await mediaFiles.olderThan(cutoff);
                const removed = await pruneMedia(rows);
                return `清理 ${removed} 个未引用文件`;
            },
        });
        return undefined;
    },
};
