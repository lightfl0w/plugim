import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@plugim/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backupSqlite, pruneBackups } from "../src/db-backup";
import { installLifecycle } from "../src/lifecycle";
import { installFileLogger, pruneLogs } from "../src/logger";

const silent: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const tempDir = (name: string) =>
    mkdtempSync(join(tmpdir(), `plugim-${name}-`));

describe("logger", () => {
    it("按大小切分并保留跨天文件", async () => {
        const dir = tempDir("log");
        const now = new Date("2026-05-01T03:04:05.000Z");
        const logger = installFileLogger({
            dir,
            maxBytes: 64 * 1024,
            keepDays: 5,
            keepFiles: 20,
            now: () => now,
        });
        expect(logger).not.toBeNull();
        logger?.write(`${"x".repeat(70_000)}\n`);
        logger?.write("second\n");
        await logger?.flush();
        await logger?.close();
        expect(readdirSync(dir).sort()).toEqual([
            "server-2026-05-01.1.log",
            "server-2026-05-01.log",
        ]);
    });

    it("跨天写入自动切到新文件", async () => {
        const dir = tempDir("log-day");
        let clock = new Date("2026-05-01T23:59:00.000Z");
        const logger = installFileLogger({
            dir,
            maxBytes: 64 * 1024,
            keepDays: 30,
            keepFiles: 20,
            now: () => clock,
        });
        logger?.write("a\n");
        clock = new Date("2026-05-02T00:01:00.000Z");
        logger?.write("b\n");
        await logger?.flush();
        await logger?.close();
        expect(readdirSync(dir).sort()).toEqual([
            "server-2026-05-01.log",
            "server-2026-05-02.log",
        ]);
    });

    it("按天数清理过期日志", () => {
        const dir = tempDir("log-prune");
        writeFileSync(join(dir, "server-2026-01-01.log"), "old");
        writeFileSync(join(dir, "server-2026-01-01.2.log"), "old");
        writeFileSync(join(dir, "server-2026-05-01.log"), "new");
        const removed = pruneLogs(
            dir,
            7,
            100,
            () => new Date("2026-05-02T00:00:00Z"),
        );
        expect(removed).toHaveLength(2);
        expect(readdirSync(dir)).toEqual(["server-2026-05-01.log"]);
    });

    it("按份数清理多余日志", () => {
        const dir = tempDir("log-files");
        for (let index = 0; index < 6; index += 1) {
            writeFileSync(join(dir, `server-2026-05-01.${index}.log`), "x");
        }
        const removed = pruneLogs(
            dir,
            30,
            2,
            () => new Date("2026-05-01T10:00:00Z"),
        );
        expect(removed).toHaveLength(4);
        expect(readdirSync(dir)).toHaveLength(2);
    });

    it("不配置目录时不启用文件日志", () => {
        expect(installFileLogger({ dir: "  " })).toBeNull();
    });
});

describe("lifecycle", () => {
    it("收到 SIGTERM 只关闭一次并退出", async () => {
        const codes: number[] = [];
        let stops = 0;
        const lifecycle = installLifecycle({
            log: silent,
            stop: async () => {
                stops += 1;
            },
            exit: (code) => codes.push(code),
            timeoutMs: 500,
        });
        process.emit("SIGTERM");
        await sleep(20);
        process.emit("SIGINT");
        await sleep(20);
        lifecycle.uninstall();
        expect(stops).toBe(1);
        expect(codes).toEqual([0]);
    });

    it("关闭超时后仍然退出", async () => {
        const codes: number[] = [];
        const lifecycle = installLifecycle({
            log: silent,
            stop: () => new Promise<void>(() => undefined),
            exit: (code) => codes.push(code),
            timeoutMs: 60,
        });
        void lifecycle.shutdown(1, "test");
        await sleep(160);
        lifecycle.uninstall();
        expect(codes).toEqual([1]);
    });

    it("挂载和卸载信号监听", () => {
        const before = process.listenerCount("SIGTERM");
        const lifecycle = installLifecycle({
            log: silent,
            stop: async () => undefined,
            exit: () => undefined,
        });
        expect(process.listenerCount("SIGTERM")).toBe(before + 1);
        expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
        lifecycle.uninstall();
        expect(process.listenerCount("SIGTERM")).toBe(before);
    });
});

describe("db-backup", () => {
    const makeDb = (file: string) => {
        const db = new Database(file);
        db.pragma("journal_mode = WAL");
        db.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, content TEXT)");
        db.prepare("INSERT INTO messages (id, content) VALUES (?, ?)").run(
            "m1",
            "hello",
        );
        db.close();
    };

    it("生成可独立打开的备份", async () => {
        const root = tempDir("backup");
        const dbFile = join(root, "plugim.db");
        makeDb(dbFile);
        const result = await backupSqlite({
            dbFile,
            dir: join(root, "backups"),
            keep: 3,
            now: () => new Date("2026-05-01T10:00:00.000Z"),
        });
        expect(existsSync(result.file)).toBe(true);
        expect(result.bytes).toBeGreaterThan(0);
        const copy = new Database(result.file, { readonly: true });
        expect(copy.prepare("SELECT content FROM messages").get()).toEqual({
            content: "hello",
        });
        copy.close();
    });

    it("按份数清理旧备份", async () => {
        const root = tempDir("backup-keep");
        const dbFile = join(root, "plugim.db");
        makeDb(dbFile);
        const dir = join(root, "backups");
        for (let index = 0; index < 5; index += 1) {
            await backupSqlite({
                dbFile,
                dir,
                keep: 2,
                now: () => new Date(Date.UTC(2026, 4, 1, 10, index, 0)),
            });
        }
        const files = readdirSync(dir).filter((name) =>
            name.startsWith("plugim-"),
        );
        expect(files).toHaveLength(2);
    });

    it("数据库文件缺失时报错", async () => {
        const root = tempDir("backup-missing");
        await expect(
            backupSqlite({ dbFile: join(root, "none.db"), dir: root }),
        ).rejects.toThrow();
    });

    it("保留份数至少为 1", () => {
        const dir = tempDir("backup-prune");
        writeFileSync(join(dir, "plugim-2026-05-01-10-00-00.db"), "x");
        writeFileSync(join(dir, "plugim-2026-05-01-11-00-00.db"), "x");
        expect(pruneBackups(dir, 0)).toHaveLength(1);
        expect(readdirSync(dir)).toHaveLength(1);
    });
});
