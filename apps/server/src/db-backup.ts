import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync,
    unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { installConfigPath } from "./installConfig";

export interface BackupOptions {
    dbFile: string;
    dir: string;
    keep?: number;
    now?: () => Date;
}

export interface BackupResult {
    file: string;
    bytes: number;
    installFile: string | null;
    removed: string[];
}

const BACKUP_RE = /^plugim-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/;

const stamp = (date: Date): string =>
    date.toISOString().slice(0, 19).replace(/[:T]/g, "-");

export const pruneBackups = (dir: string, keep: number): string[] => {
    const limit = Math.max(1, Math.floor(keep));
    let names: string[];
    try {
        names = readdirSync(dir);
    } catch {
        return [];
    }
    const files = names.filter((name) => BACKUP_RE.test(name)).sort();
    const removed: string[] = [];
    for (const name of files.slice(0, Math.max(0, files.length - limit))) {
        try {
            unlinkSync(resolve(dir, name));
            removed.push(name);
        } catch {}
    }
    return removed;
};

export const backupSqlite = async (
    options: BackupOptions,
): Promise<BackupResult> => {
    const source = resolve(process.cwd(), options.dbFile);
    if (!existsSync(source)) {
        throw new Error(`数据库文件不存在：${options.dbFile}`);
    }
    const dir = resolve(process.cwd(), options.dir);
    mkdirSync(dir, { recursive: true });
    const now = options.now ?? (() => new Date());
    const file = resolve(dir, `plugim-${stamp(now())}.db`);
    const db = new Database(source);
    try {
        db.pragma("busy_timeout = 10000");
        await db.backup(file);
    } finally {
        db.close();
    }
    let installFile: string | null = null;
    const configFile = installConfigPath();
    if (existsSync(configFile)) {
        installFile = resolve(dir, "install.json");
        copyFileSync(configFile, installFile);
    }
    const removed = pruneBackups(dir, options.keep ?? 7);
    return {
        file,
        bytes: statSync(file).size,
        installFile,
        removed,
    };
};
