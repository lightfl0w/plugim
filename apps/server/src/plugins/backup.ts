import type { Plugin } from "@plugim/core";
import { backupSqlite } from "../db-backup";
import type { AppConfig } from "./config";
import type { TasksService } from "./tasks";

const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
};

const envKeep = (): number => {
    const value = Number(process.env.PLUGIM_BACKUP_KEEP);
    return Number.isInteger(value) && value > 0 && value <= 365 ? value : 7;
};

export const backupPlugin: Plugin = {
    name: "backup",
    description: "SQLite 数据库定时热备份",
    inject: ["config", "tasks"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        const tasks = ctx.get<TasksService>("tasks");
        const dir =
            (process.env.PLUGIM_BACKUP_DIR ?? "").trim() || "data/backups";
        const keep = envKeep();

        tasks.register({
            name: "db-backup",
            title: "数据库备份",
            description: `把 SQLite 数据库热备份到 ${dir}，保留最近 ${keep} 份`,
            intervalMinutes: 1440,
            run: async () => {
                if (config.dbDriver !== "sqlite") {
                    return "当前为 PostgreSQL，请用 pg_dump 定时备份";
                }
                const result = await backupSqlite({
                    dbFile: config.dbFile,
                    dir,
                    keep,
                });
                ctx.log.info(`backup written: ${result.file}`);
                return `备份 ${result.file}（${formatBytes(result.bytes)}），清理 ${result.removed.length} 份旧备份`;
            },
        });
        return undefined;
    },
};
