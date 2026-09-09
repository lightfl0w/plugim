import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@plugim/core";
import Database from "better-sqlite3";
import { and, desc, eq, or } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import {
    primaryKey as pgPrimaryKey,
    pgTable,
    text as pgText,
    timestamp,
} from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import {
    integer,
    primaryKey,
    sqliteTable,
    text as sqliteText,
} from "drizzle-orm/sqlite-core";
import postgres from "postgres";
import type {
    AccountsStore,
    FriendEdge,
    FriendsStore,
    MessageStore,
    UserWithHash,
} from "../types";
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

const usersSqlite = sqliteTable("users", {
    id: sqliteText("id").primaryKey(),
    username: sqliteText("username").notNull().unique(),
    passwordHash: sqliteText("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
});

const usersPg = pgTable("users", {
    id: pgText("id").primaryKey(),
    username: pgText("username").notNull().unique(),
    passwordHash: pgText("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const friendshipsSqlite = sqliteTable(
    "friendships",
    {
        requesterId: sqliteText("requester_id").notNull(),
        addresseeId: sqliteText("addressee_id").notNull(),
        status: sqliteText("status").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.requesterId, table.addresseeId] }),
    ],
);

const friendshipsPg = pgTable(
    "friendships",
    {
        requesterId: pgText("requester_id").notNull(),
        addresseeId: pgText("addressee_id").notNull(),
        status: pgText("status").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        pgPrimaryKey({
            columns: [table.requesterId, table.addresseeId],
        }),
    ],
);

const CREATE_SQLITE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
)`;

const CREATE_PG = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id)
)`;

interface UserRow {
    id: string;
    username: string;
    passwordHash: string;
    createdAt: Date | number;
}

interface EdgeRow {
    requesterId: string;
    addresseeId: string;
    status: string;
    createdAt: Date | number;
}

const toIso = (value: Date | number): string =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const storagePlugin: Plugin = {
    name: "storage",
    description: "存储驱动(sqlite / postgres)",
    core: true,
    provides: ["store", "accounts", "friendships"],
    inject: ["config"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        let store: MessageStore;
        let accounts: AccountsStore;
        let friends: FriendsStore;

        if (config.dbDriver === "postgres") {
            const client = postgres(config.dbUrl);
            await client.unsafe(CREATE_PG);
            const db = drizzlePg(client);

            const userToRow = (row: UserRow) => ({
                id: row.id,
                username: row.username,
                passwordHash: row.passwordHash,
                createdAt: toIso(row.createdAt),
            });
            const edgeToRow = (row: EdgeRow): FriendEdge => ({
                requesterId: row.requesterId,
                addresseeId: row.addresseeId,
                status: row.status as FriendEdge["status"],
                createdAt: toIso(row.createdAt),
            });

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

            accounts = {
                async create(username, passwordHash) {
                    const id = crypto.randomUUID();
                    const rows = await db
                        .insert(usersPg)
                        .values({ id, username, passwordHash })
                        .returning();
                    return userToRow(rows[0]);
                },
                async byUsername(username) {
                    const rows = await db
                        .select()
                        .from(usersPg)
                        .where(eq(usersPg.username, username))
                        .limit(1);
                    const row = rows[0];
                    return row ? userToRow(row) : null;
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(usersPg)
                        .where(eq(usersPg.id, id))
                        .limit(1);
                    const row = rows[0];
                    if (!row) return null;
                    const { passwordHash: _hash, ...user } = userToRow(row);
                    return user;
                },
                async byIds(ids) {
                    if (ids.length === 0) return [];
                    const rows = await db.select().from(usersPg);
                    return rows
                        .filter((row) => ids.includes(row.id))
                        .map(userToRow);
                },
            };

            friends = {
                async request(requesterId, addresseeId) {
                    await db
                        .insert(friendshipsPg)
                        .values({
                            requesterId,
                            addresseeId,
                            status: "pending",
                            createdAt: new Date(),
                        })
                        .onConflictDoNothing();
                },
                async accept(requesterId, addresseeId) {
                    const rows = await db
                        .update(friendshipsPg)
                        .set({ status: "accepted" })
                        .where(
                            and(
                                eq(friendshipsPg.requesterId, requesterId),
                                eq(friendshipsPg.addresseeId, addresseeId),
                                eq(friendshipsPg.status, "pending"),
                            ),
                        )
                        .returning();
                    if (rows.length === 0)
                        throw new Error("没有待处理的好友申请");
                },
                async removeBetween(aId, bId) {
                    await db
                        .delete(friendshipsPg)
                        .where(
                            or(
                                and(
                                    eq(friendshipsPg.requesterId, aId),
                                    eq(friendshipsPg.addresseeId, bId),
                                ),
                                and(
                                    eq(friendshipsPg.requesterId, bId),
                                    eq(friendshipsPg.addresseeId, aId),
                                ),
                            ),
                        );
                },
                async block(blockerId, targetId) {
                    await db
                        .delete(friendshipsPg)
                        .where(
                            or(
                                and(
                                    eq(friendshipsPg.requesterId, blockerId),
                                    eq(friendshipsPg.addresseeId, targetId),
                                ),
                                and(
                                    eq(friendshipsPg.requesterId, targetId),
                                    eq(friendshipsPg.addresseeId, blockerId),
                                ),
                            ),
                        );
                    await db.insert(friendshipsPg).values({
                        requesterId: blockerId,
                        addresseeId: targetId,
                        status: "blocked",
                        createdAt: new Date(),
                    });
                },
                async unblock(blockerId, targetId) {
                    await db
                        .delete(friendshipsPg)
                        .where(
                            and(
                                eq(friendshipsPg.requesterId, blockerId),
                                eq(friendshipsPg.addresseeId, targetId),
                                eq(friendshipsPg.status, "blocked"),
                            ),
                        );
                },
                async edgesOf(userId) {
                    const rows = await db
                        .select()
                        .from(friendshipsPg)
                        .where(
                            or(
                                eq(friendshipsPg.requesterId, userId),
                                eq(friendshipsPg.addresseeId, userId),
                            ),
                        );
                    return rows.map(edgeToRow);
                },
            };

            ctx.log.info(`storage driver: postgres (${config.dbUrl})`);
        } else {
            const file = resolve(process.cwd(), config.dbFile);
            mkdirSync(dirname(file), { recursive: true });
            const client = new Database(file);
            client.exec(CREATE_SQLITE);
            const db = drizzleSqlite(client);

            const userToRow = (row: UserRow): UserWithHash => ({
                id: row.id,
                username: row.username,
                passwordHash: row.passwordHash,
                createdAt: toIso(row.createdAt),
            });
            const edgeToRow = (row: EdgeRow): FriendEdge => ({
                requesterId: row.requesterId,
                addresseeId: row.addresseeId,
                status: row.status as FriendEdge["status"],
                createdAt: toIso(row.createdAt),
            });

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

            accounts = {
                async create(username, passwordHash) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    await db
                        .insert(usersSqlite)
                        .values({ id, username, passwordHash, createdAt: now });
                    return {
                        id,
                        username,
                        createdAt: new Date(now).toISOString(),
                    };
                },
                async byUsername(username) {
                    const rows = await db
                        .select()
                        .from(usersSqlite)
                        .where(eq(usersSqlite.username, username))
                        .limit(1);
                    const row = rows[0];
                    return row ? userToRow(row) : null;
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(usersSqlite)
                        .where(eq(usersSqlite.id, id))
                        .limit(1);
                    const row = rows[0];
                    if (!row) return null;
                    const { passwordHash: _hash, ...user } = userToRow(row);
                    return user;
                },
                async byIds(ids) {
                    if (ids.length === 0) return [];
                    const rows = await db.select().from(usersSqlite);
                    return rows
                        .filter((row) => ids.includes(row.id))
                        .map(userToRow);
                },
            };

            friends = {
                async request(requesterId, addresseeId) {
                    await db
                        .insert(friendshipsSqlite)
                        .values({
                            requesterId,
                            addresseeId,
                            status: "pending",
                            createdAt: Date.now(),
                        })
                        .onConflictDoNothing();
                },
                async accept(requesterId, addresseeId) {
                    const rows = await db
                        .update(friendshipsSqlite)
                        .set({ status: "accepted" })
                        .where(
                            and(
                                eq(friendshipsSqlite.requesterId, requesterId),
                                eq(friendshipsSqlite.addresseeId, addresseeId),
                                eq(friendshipsSqlite.status, "pending"),
                            ),
                        )
                        .returning();
                    if (rows.length === 0)
                        throw new Error("没有待处理的好友申请");
                },
                async removeBetween(aId, bId) {
                    await db
                        .delete(friendshipsSqlite)
                        .where(
                            or(
                                and(
                                    eq(friendshipsSqlite.requesterId, aId),
                                    eq(friendshipsSqlite.addresseeId, bId),
                                ),
                                and(
                                    eq(friendshipsSqlite.requesterId, bId),
                                    eq(friendshipsSqlite.addresseeId, aId),
                                ),
                            ),
                        );
                },
                async block(blockerId, targetId) {
                    await db
                        .delete(friendshipsSqlite)
                        .where(
                            or(
                                and(
                                    eq(
                                        friendshipsSqlite.requesterId,
                                        blockerId,
                                    ),
                                    eq(friendshipsSqlite.addresseeId, targetId),
                                ),
                                and(
                                    eq(friendshipsSqlite.requesterId, targetId),
                                    eq(
                                        friendshipsSqlite.addresseeId,
                                        blockerId,
                                    ),
                                ),
                            ),
                        );
                    await db.insert(friendshipsSqlite).values({
                        requesterId: blockerId,
                        addresseeId: targetId,
                        status: "blocked",
                        createdAt: Date.now(),
                    });
                },
                async unblock(blockerId, targetId) {
                    await db
                        .delete(friendshipsSqlite)
                        .where(
                            and(
                                eq(friendshipsSqlite.requesterId, blockerId),
                                eq(friendshipsSqlite.addresseeId, targetId),
                                eq(friendshipsSqlite.status, "blocked"),
                            ),
                        );
                },
                async edgesOf(userId) {
                    const rows = await db
                        .select()
                        .from(friendshipsSqlite)
                        .where(
                            or(
                                eq(friendshipsSqlite.requesterId, userId),
                                eq(friendshipsSqlite.addresseeId, userId),
                            ),
                        );
                    return rows.map(edgeToRow);
                },
            };

            ctx.log.info(`storage driver: sqlite (${file})`);
        }

        ctx.provide<MessageStore>("store", store);
        ctx.provide<AccountsStore>("accounts", accounts);
        ctx.provide<FriendsStore>("friendships", friends);
        return undefined;
    },
};
