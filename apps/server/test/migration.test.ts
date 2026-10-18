import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@plugim/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/plugins/config";
import { storagePlugin } from "../src/plugins/storage";
import type { MessageStore, ReadsStore } from "../src/types";

const legacyDb = (file: string): void => {
    const db = new Database(file);
    db.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session TEXT NOT NULL,
          sender TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          recalled_at INTEGER,
          quote TEXT,
          mentions TEXT,
          kind TEXT,
          file TEXT,
          link TEXT,
          reactions TEXT,
          red_packet TEXT,
          transfer TEXT,
          aa_bill TEXT
        );
        CREATE TABLE reads (
          user_id TEXT NOT NULL,
          session TEXT NOT NULL,
          read_at INTEGER NOT NULL,
          PRIMARY KEY (user_id, session)
        );
    `);
    const insert = db.prepare(
        "INSERT INTO messages (id, session, sender, content, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run("a", "s1", "u1", "tie-1", 1000);
    insert.run("b", "s1", "u1", "tie-2", 1000);
    insert.run("c", "s1", "u2", "tie-3", 1000);
    insert.run("d", "s2", "u1", "later", 5000);
    db.prepare(
        "INSERT INTO reads (user_id, session, read_at) VALUES (?, ?, ?)",
    ).run("u1", "s1", 1000);
    db.close();
};

const bootStore = async (file: string) => {
    const ctx = new Context();
    process.env.PLUGIM_INSTALL_FILE = join(
        mkdtempSync(join(tmpdir(), "plugim-mig-")),
        "install.json",
    );
    ctx.provide<AppConfig>("config", {
        port: 0,
        dbDriver: "sqlite",
        dbFile: file,
        dbUrl: "",
        logDir: mkdtempSync(join(tmpdir(), "plugim-mig-log-")),
        installFile: process.env.PLUGIM_INSTALL_FILE,
        defaultSession: "general",
        bootstrapAdmins: [],
        allowRegister: true,
        inviteCode: "",
        retentionDays: 0,
        site: { name: "", icon: "", description: "" },
    } as AppConfig);
    ctx.plugin(storagePlugin);
    await ctx.start();
    return {
        store: ctx.get<MessageStore>("store"),
        reads: ctx.get<ReadsStore>("reads"),
        ctx,
    };
};

describe("legacy schema migration", () => {
    it("backfills a dense seq per session for equal timestamps", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugim-mig-")), "a.db");
        legacyDb(file);
        const { store, ctx } = await bootStore(file);
        const s1 = await store.list("s1", 50);
        expect(s1.map((row) => [row.content, row.seq])).toEqual([
            ["tie-1", 1],
            ["tie-2", 2],
            ["tie-3", 3],
        ]);
        const s2 = await store.list("s2", 50);
        expect(s2.map((row) => row.seq)).toEqual([1]);
        await ctx.stop();
    });

    it("keeps seq paging exact on migrated rows", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugim-mig-")), "b.db");
        legacyDb(file);
        const { store, ctx } = await bootStore(file);
        const older = await store.list("s1", 2, { beforeSeq: 3 });
        expect(older.map((row) => row.seq)).toEqual([1, 2]);
        const newer = await store.list("s1", 5, { afterSeq: 1 });
        expect(newer.map((row) => row.seq)).toEqual([2, 3]);
        await ctx.stop();
    });

    it("keeps id-based paging backward compatible", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugim-mig-")), "c.db");
        legacyDb(file);
        const { store, ctx } = await bootStore(file);
        const all = await store.list("s1", 50);
        const older = await store.list("s1", 2, {
            before: all[2].createdAt,
            beforeId: all[2].id,
        });
        expect(older.map((row) => row.content)).toEqual(["tie-2", "tie-3"]);
        await ctx.stop();
    });

    it("continues numbering after migration", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugim-mig-")), "d.db");
        legacyDb(file);
        const { store, ctx } = await bootStore(file);
        const saved = await store.save({
            session: "s1",
            sender: "u1",
            content: "fresh",
        });
        expect(saved.seq).toBe(4);
        await ctx.stop();
    });

    it("counts unread from migrated rows and read cursors", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugim-mig-")), "e.db");
        legacyDb(file);
        const { store, reads, ctx } = await bootStore(file);
        await reads.set("u1", "s1", new Date().toISOString(), 1);
        const rows = await store.summaries({
            userId: "u1",
            username: "u1",
            sessions: ["s1", "s2"],
        });
        const s1 = rows.find((row) => row.session === "s1");
        expect(s1?.lastSeq).toBe(3);
        expect(s1?.readSeq).toBe(1);
        expect(s1?.unread).toBe(1);
        expect(s1?.lastMessage?.content).toBe("tie-3");
        const s2 = rows.find((row) => row.session === "s2");
        expect(s2?.unread).toBe(0);
        await ctx.stop();
    });

    it("returns delta rows after a cursor on migrated data", async () => {
        const file = join(mkdtempSync(join(tmpdir(), "plugim-mig-")), "f.db");
        legacyDb(file);
        const { store, ctx } = await bootStore(file);
        const rows = await store.since({ session: "s1", seq: 1, limit: 10 });
        expect(rows.map((row) => row.seq)).toEqual([2, 3]);
        await ctx.stop();
    });
});
