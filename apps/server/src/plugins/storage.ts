import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@plugim/core";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { pgTable, text as pgText, timestamp } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import {
    integer,
    sqliteTable,
    text as sqliteText,
} from "drizzle-orm/sqlite-core";
import postgres from "postgres";
import type { MessageStore } from "../types";
import type { AppConfig } from "./config";

const messagesSqlite = sqliteTable("messages", {
    id: sqliteText("id").primaryKey(),
    session: sqliteText("session").notNull(),
    sender: sqliteText("sender").notNull(),
    content: sqliteText("content").notNull(),
    createdAt: integer("created_at").notNull(),
});

const messagesPg = pgTable("messages", {
    id: pgText("id").primaryKey(),
    session: pgText("session").notNull(),
    sender: pgText("sender").notNull(),
    content: pgText("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const CREATE_SQLITE = `CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`;

const CREATE_PG = `CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export const storagePlugin: Plugin = {
    name: "storage",
    inject: ["config"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        let store: MessageStore;

        if (config.dbDriver === "postgres") {
            const client = postgres(config.dbUrl);
            await client.unsafe(CREATE_PG);
            const db = drizzlePg(client);
            store = {
                async save(input) {
                    const id = crypto.randomUUID();
                    const rows = await db
                        .insert(messagesPg)
                        .values({ id, ...input })
                        .returning();
                    const row = rows[0];
                    return {
                        id: row.id,
                        session: row.session,
                        sender: row.sender,
                        content: row.content,
                        createdAt: row.createdAt.toISOString(),
                    };
                },
                async list(session, limit) {
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(eq(messagesPg.session, session))
                        .orderBy(desc(messagesPg.createdAt))
                        .limit(limit);
                    return rows
                        .map((row) => ({
                            id: row.id,
                            session: row.session,
                            sender: row.sender,
                            content: row.content,
                            createdAt: row.createdAt.toISOString(),
                        }))
                        .reverse();
                },
            };
            ctx.log.info(`storage driver: postgres (${config.dbUrl})`);
        } else {
            const file = resolve(process.cwd(), config.dbFile);
            mkdirSync(dirname(file), { recursive: true });
            const client = new Database(file);
            client.exec(CREATE_SQLITE);
            const db = drizzleSqlite(client);
            store = {
                async save(input) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    await db
                        .insert(messagesSqlite)
                        .values({ id, ...input, createdAt: now });
                    return {
                        id,
                        ...input,
                        createdAt: new Date(now).toISOString(),
                    };
                },
                async list(session, limit) {
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(eq(messagesSqlite.session, session))
                        .orderBy(desc(messagesSqlite.createdAt))
                        .limit(limit);
                    return rows
                        .map((row) => ({
                            ...row,
                            createdAt: new Date(row.createdAt).toISOString(),
                        }))
                        .reverse();
                },
            };
            ctx.log.info(`storage driver: sqlite (${file})`);
        }

        ctx.provide<MessageStore>("store", store);
        return undefined;
    },
};
