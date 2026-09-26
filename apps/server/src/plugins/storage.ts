import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@plugim/core";
import type { FileMeta, GroupRole, MessageQuote } from "@plugim/protocol";
import Database from "better-sqlite3";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import {
    boolean as pgBoolean,
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
    AdminUserRow,
    FriendEdge,
    FriendsStore,
    GroupMemberRow,
    GroupRow,
    GroupsStore,
    MessageStore,
    ReadsStore,
    SettingsStore,
    UserWithHash,
} from "../types";
import type { AppConfig } from "./config";

const messagesSqlite = sqliteTable("messages", {
    id: sqliteText("id").primaryKey(),
    session: sqliteText("session").notNull(),
    sender: sqliteText("sender").notNull(),
    content: sqliteText("content").notNull(),
    createdAt: integer("created_at").notNull(),
    recalledAt: integer("recalled_at"),
    quote: sqliteText("quote"),
    mentions: sqliteText("mentions"),
    kind: sqliteText("kind"),
    file: sqliteText("file"),
});

const messagesPg = pgTable("messages", {
    id: pgText("id").primaryKey(),
    session: pgText("session").notNull(),
    sender: pgText("sender").notNull(),
    content: pgText("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    quote: pgText("quote"),
    mentions: pgText("mentions"),
    kind: pgText("kind"),
    file: pgText("file"),
});

const usersSqlite = sqliteTable("users", {
    id: sqliteText("id").primaryKey(),
    username: sqliteText("username").notNull().unique(),
    passwordHash: sqliteText("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
});

const usersPg = pgTable("users", {
    id: pgText("id").primaryKey(),
    username: pgText("username").notNull().unique(),
    passwordHash: pgText("password_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    isAdmin: pgBoolean("is_admin").notNull().default(false),
    banned: pgBoolean("banned").notNull().default(false),
});

const groupsSqlite = sqliteTable("groups", {
    id: sqliteText("id").primaryKey(),
    name: sqliteText("name").notNull(),
    ownerId: sqliteText("owner_id").notNull(),
    notice: sqliteText("notice").notNull().default(""),
    muteAll: integer("mute_all", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
});

const groupsPg = pgTable("groups", {
    id: pgText("id").primaryKey(),
    name: pgText("name").notNull(),
    ownerId: pgText("owner_id").notNull(),
    notice: pgText("notice").notNull().default(""),
    muteAll: pgBoolean("mute_all").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const groupMembersSqlite = sqliteTable(
    "group_members",
    {
        groupId: sqliteText("group_id").notNull(),
        userId: sqliteText("user_id").notNull(),
        role: sqliteText("role").notNull(),
        muted: integer("muted", { mode: "boolean" }).notNull().default(false),
        joinedAt: integer("joined_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

const groupMembersPg = pgTable(
    "group_members",
    {
        groupId: pgText("group_id").notNull(),
        userId: pgText("user_id").notNull(),
        role: pgText("role").notNull(),
        muted: pgBoolean("muted").notNull().default(false),
        joinedAt: timestamp("joined_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [pgPrimaryKey({ columns: [table.groupId, table.userId] })],
);

const readsSqlite = sqliteTable(
    "reads",
    {
        userId: sqliteText("user_id").notNull(),
        session: sqliteText("session").notNull(),
        readAt: integer("read_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.userId, table.session] })],
);

const readsPg = pgTable(
    "reads",
    {
        userId: pgText("user_id").notNull(),
        session: pgText("session").notNull(),
        readAt: timestamp("read_at", { withTimezone: true }).notNull(),
    },
    (table) => [pgPrimaryKey({ columns: [table.userId, table.session] })],
);

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

const settingsSqlite = sqliteTable("settings", {
    key: sqliteText("key").primaryKey(),
    value: sqliteText("value").notNull(),
});

const settingsPg = pgTable("settings", {
    key: pgText("key").primaryKey(),
    value: pgText("value").notNull(),
});

const CREATE_SQLITE = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  recalled_at INTEGER,
  quote TEXT,
  mentions TEXT,
  kind TEXT,
  file TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  mute_all INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

const CREATE_PG = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recalled_at TIMESTAMPTZ,
  quote TEXT,
  mentions TEXT,
  kind TEXT,
  file TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  banned BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  mute_all BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

const toIso = (value: Date | number): string =>
    value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const serializeQuote = (quote?: MessageQuote | null): string | null =>
    quote ? JSON.stringify(quote) : null;

const parseQuote = (raw: unknown): MessageQuote | null => {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<MessageQuote>;
        if (
            typeof parsed?.sender === "string" &&
            typeof parsed?.content === "string"
        )
            return { sender: parsed.sender, content: parsed.content };
    } catch {}
    return null;
};

const serializeMentions = (mentions?: string[] | null): string | null =>
    mentions && mentions.length > 0 ? JSON.stringify(mentions) : null;

const parseMentions = (raw: unknown): string[] | null => {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed.filter(
                (item): item is string => typeof item === "string",
            );
    } catch {}
    return null;
};

const parseFile = (raw: unknown): FileMeta | null => {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<FileMeta>;
        if (
            typeof parsed?.name === "string" &&
            typeof parsed?.size === "number"
        )
            return { name: parsed.name, size: parsed.size };
    } catch {}
    return null;
};

interface MessageDbRow {
    id: string;
    session: string;
    sender: string;
    content: string;
    createdAt: Date | number;
    recalledAt: Date | number | null;
    quote: string | null;
    mentions: string | null;
    kind: string | null;
    file: string | null;
}

const messageRowToChat = (row: MessageDbRow) => ({
    id: row.id,
    session: row.session,
    sender: row.sender,
    content: row.content,
    createdAt: toIso(row.createdAt),
    recalledAt: row.recalledAt === null ? null : toIso(row.recalledAt),
    quote: parseQuote(row.quote),
    mentions: parseMentions(row.mentions),
    kind: (row.kind ?? "text") as "text",
    file: parseFile(row.file),
});

export const storagePlugin: Plugin = {
    name: "storage",
    description: "存储驱动(sqlite / postgres)",
    provides: [
        "store",
        "accounts",
        "friendships",
        "groups",
        "reads",
        "settings",
    ],
    inject: ["config"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        let store: MessageStore;
        let accounts: AccountsStore;
        let friends: FriendsStore;
        let groups: GroupsStore;
        let reads: ReadsStore;
        let settings: SettingsStore;

        if (config.dbDriver === "postgres") {
            const client = postgres(config.dbUrl);
            await client.unsafe(CREATE_PG);
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS quote TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS file TEXT",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE",
            );
            const db = drizzlePg(client);

            const userToRow = (
                row: typeof usersPg.$inferSelect,
            ): UserWithHash => ({
                id: row.id,
                username: row.username,
                passwordHash: row.passwordHash,
                createdAt: toIso(row.createdAt),
                isAdmin: row.isAdmin,
                banned: row.banned,
            });
            const edgeToRow = (row: {
                requesterId: string;
                addresseeId: string;
                status: string;
                createdAt: Date;
            }): FriendEdge => ({
                requesterId: row.requesterId,
                addresseeId: row.addresseeId,
                status: row.status as FriendEdge["status"],
                createdAt: toIso(row.createdAt),
            });
            const groupToRow = (
                row: typeof groupsPg.$inferSelect,
            ): GroupRow => ({
                id: row.id,
                name: row.name,
                ownerId: row.ownerId,
                notice: row.notice,
                muteAll: row.muteAll,
                createdAt: toIso(row.createdAt),
            });

            store = {
                async save(input) {
                    const id = crypto.randomUUID();
                    const { quote, mentions, file, ...rest } = input;
                    const rows = await db
                        .insert(messagesPg)
                        .values({
                            id,
                            ...rest,
                            quote: serializeQuote(quote),
                            mentions: serializeMentions(mentions),
                            file: file ? JSON.stringify(file) : null,
                        })
                        .returning();
                    return messageRowToChat(rows[0]);
                },
                async list(session, limit, before) {
                    const conds = [eq(messagesPg.session, session)];
                    if (before)
                        conds.push(lt(messagesPg.createdAt, new Date(before)));
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(and(...conds))
                        .orderBy(desc(messagesPg.createdAt))
                        .limit(limit);
                    return rows.map(messageRowToChat).reverse();
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(eq(messagesPg.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row ? messageRowToChat(row) : null;
                },
                async markRecalled(id) {
                    const rows = await db
                        .update(messagesPg)
                        .set({ recalledAt: new Date() })
                        .where(eq(messagesPg.id, id))
                        .returning();
                    return rows[0]?.recalledAt
                        ? rows[0].recalledAt.toISOString()
                        : null;
                },
            };

            accounts = {
                async create(username, passwordHash) {
                    const id = crypto.randomUUID();
                    const existing = await db.select().from(usersPg);
                    const rows = await db
                        .insert(usersPg)
                        .values({
                            id,
                            username,
                            passwordHash,
                            isAdmin: existing.length === 0,
                        })
                        .returning();
                    const row = rows[0];
                    return {
                        id: row.id,
                        username: row.username,
                        createdAt: toIso(row.createdAt),
                    };
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
                    const row = await this.fullById(id);
                    if (!row) return null;
                    const { passwordHash: _hash, ...user } = row;
                    return user;
                },
                async fullById(id) {
                    const rows = await db
                        .select()
                        .from(usersPg)
                        .where(eq(usersPg.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row ? userToRow(row) : null;
                },
                async byIds(ids) {
                    if (ids.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(usersPg)
                        .where(inArray(usersPg.id, ids));
                    return rows.map((row) => ({
                        id: row.id,
                        username: row.username,
                        createdAt: toIso(row.createdAt),
                    }));
                },
                async listAll() {
                    const rows = await db.select().from(usersPg);
                    return rows.map(
                        (row): AdminUserRow => ({
                            id: row.id,
                            username: row.username,
                            createdAt: toIso(row.createdAt),
                            isAdmin: row.isAdmin,
                            banned: row.banned,
                        }),
                    );
                },
                async setFlag(id, flag, value) {
                    await db
                        .update(usersPg)
                        .set(
                            flag === "isAdmin"
                                ? { isAdmin: value }
                                : { banned: value },
                        )
                        .where(eq(usersPg.id, id));
                },
                async count() {
                    const rows = await db
                        .select({ id: usersPg.id })
                        .from(usersPg);
                    return rows.length;
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

            groups = {
                async create(name, ownerId) {
                    const id = crypto.randomUUID();
                    const rows = await db
                        .insert(groupsPg)
                        .values({ id, name, ownerId })
                        .returning();
                    return groupToRow(rows[0]);
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(groupsPg)
                        .where(eq(groupsPg.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row ? groupToRow(row) : null;
                },
                async remove(id) {
                    await db
                        .delete(groupMembersPg)
                        .where(eq(groupMembersPg.groupId, id));
                    await db.delete(groupsPg).where(eq(groupsPg.id, id));
                    await db
                        .delete(readsPg)
                        .where(eq(readsPg.session, `g:${id}`));
                },
                async rename(id, name) {
                    await db
                        .update(groupsPg)
                        .set({ name })
                        .where(eq(groupsPg.id, id));
                },
                async setNotice(id, notice) {
                    await db
                        .update(groupsPg)
                        .set({ notice })
                        .where(eq(groupsPg.id, id));
                },
                async setMuteAll(id, on) {
                    await db
                        .update(groupsPg)
                        .set({ muteAll: on })
                        .where(eq(groupsPg.id, id));
                },
                async addMember(groupId, userId) {
                    await db
                        .insert(groupMembersPg)
                        .values({ groupId, userId, role: "member" })
                        .onConflictDoNothing();
                },
                async removeMember(groupId, userId) {
                    await db
                        .delete(groupMembersPg)
                        .where(
                            and(
                                eq(groupMembersPg.groupId, groupId),
                                eq(groupMembersPg.userId, userId),
                            ),
                        );
                },
                async setRole(groupId, userId, role) {
                    await db
                        .update(groupMembersPg)
                        .set({ role })
                        .where(
                            and(
                                eq(groupMembersPg.groupId, groupId),
                                eq(groupMembersPg.userId, userId),
                            ),
                        );
                },
                async setMuted(groupId, userId, muted) {
                    await db
                        .update(groupMembersPg)
                        .set({ muted })
                        .where(
                            and(
                                eq(groupMembersPg.groupId, groupId),
                                eq(groupMembersPg.userId, userId),
                            ),
                        );
                },
                async membersOf(groupId) {
                    const rows = await db
                        .select()
                        .from(groupMembersPg)
                        .where(eq(groupMembersPg.groupId, groupId));
                    return rows.map(
                        (row): GroupMemberRow => ({
                            userId: row.userId,
                            role: row.role as GroupRole,
                            muted: row.muted,
                            joinedAt: toIso(row.joinedAt),
                        }),
                    );
                },
                async memberIdsOf(groupId) {
                    const rows = await db
                        .select({ userId: groupMembersPg.userId })
                        .from(groupMembersPg)
                        .where(eq(groupMembersPg.groupId, groupId));
                    return rows.map((row) => row.userId);
                },
                async groupsOf(userId) {
                    const memberRows = await db
                        .select({ groupId: groupMembersPg.groupId })
                        .from(groupMembersPg)
                        .where(eq(groupMembersPg.userId, userId));
                    if (memberRows.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(groupsPg)
                        .where(
                            inArray(
                                groupsPg.id,
                                memberRows.map((row) => row.groupId),
                            ),
                        );
                    return rows.map(groupToRow);
                },
                async listAll() {
                    const rows = await db.select().from(groupsPg);
                    const memberRows = await db
                        .select({ groupId: groupMembersPg.groupId })
                        .from(groupMembersPg);
                    return rows.map((row) => ({
                        ...groupToRow(row),
                        memberCount: memberRows.filter(
                            (m) => m.groupId === row.id,
                        ).length,
                    }));
                },
                async shareGroup(aId, bId) {
                    const rows = await db
                        .select({ groupId: groupMembersPg.groupId })
                        .from(groupMembersPg)
                        .where(eq(groupMembersPg.userId, aId));
                    const groupIds = rows.map((row) => row.groupId);
                    if (groupIds.length === 0) return false;
                    const common = await db
                        .select({ groupId: groupMembersPg.groupId })
                        .from(groupMembersPg)
                        .where(
                            and(
                                inArray(groupMembersPg.groupId, groupIds),
                                eq(groupMembersPg.userId, bId),
                            ),
                        );
                    return common.length > 0;
                },
            };

            reads = {
                async set(userId, session, at) {
                    await db
                        .insert(readsPg)
                        .values({ userId, session, readAt: new Date(at) })
                        .onConflictDoUpdate({
                            target: [readsPg.userId, readsPg.session],
                            set: { readAt: new Date(at) },
                        });
                },
                async ofSession(session) {
                    const rows = await db
                        .select()
                        .from(readsPg)
                        .where(eq(readsPg.session, session));
                    return rows.map((row) => ({
                        userId: row.userId,
                        at: toIso(row.readAt),
                    }));
                },
            };

            settings = {
                async get(key) {
                    const rows = await db
                        .select()
                        .from(settingsPg)
                        .where(eq(settingsPg.key, key))
                        .limit(1);
                    return rows[0]?.value ?? null;
                },
                async set(key, value) {
                    await db
                        .insert(settingsPg)
                        .values({ key, value })
                        .onConflictDoUpdate({
                            target: settingsPg.key,
                            set: { value },
                        });
                },
            };

            ctx.log.info(`storage driver: postgres (${config.dbUrl})`);
        } else {
            const file = resolve(process.cwd(), config.dbFile);
            mkdirSync(dirname(file), { recursive: true });
            const client = new Database(file);
            client.exec(CREATE_SQLITE);
            const messageColumns = client.pragma(
                "table_info(messages)",
            ) as Array<{
                name: string;
            }>;
            for (const col of [
                "recalled_at",
                "quote",
                "mentions",
                "kind",
                "file",
            ]) {
                if (!messageColumns.some((item) => item.name === col)) {
                    const type = col === "recalled_at" ? "INTEGER" : "TEXT";
                    client.exec(
                        `ALTER TABLE messages ADD COLUMN ${col} ${type}`,
                    );
                }
            }
            const userColumns = client.pragma("table_info(users)") as Array<{
                name: string;
            }>;
            for (const col of ["is_admin", "banned"]) {
                if (!userColumns.some((item) => item.name === col)) {
                    client.exec(
                        `ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            }
            const db = drizzleSqlite(client);

            const userToRow = (
                row: typeof usersSqlite.$inferSelect,
            ): UserWithHash => ({
                id: row.id,
                username: row.username,
                passwordHash: row.passwordHash,
                createdAt: toIso(row.createdAt),
                isAdmin: row.isAdmin,
                banned: row.banned,
            });
            const edgeToRow = (row: {
                requesterId: string;
                addresseeId: string;
                status: string;
                createdAt: number;
            }): FriendEdge => ({
                requesterId: row.requesterId,
                addresseeId: row.addresseeId,
                status: row.status as FriendEdge["status"],
                createdAt: toIso(row.createdAt),
            });
            const groupToRow = (
                row: typeof groupsSqlite.$inferSelect,
            ): GroupRow => ({
                id: row.id,
                name: row.name,
                ownerId: row.ownerId,
                notice: row.notice,
                muteAll: row.muteAll,
                createdAt: toIso(row.createdAt),
            });

            store = {
                async save(input) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    const { quote, mentions, file: meta, ...rest } = input;
                    await db.insert(messagesSqlite).values({
                        id,
                        ...rest,
                        quote: serializeQuote(quote),
                        mentions: serializeMentions(mentions),
                        file: meta ? JSON.stringify(meta) : null,
                        createdAt: now,
                    });
                    return {
                        id,
                        ...rest,
                        quote: quote ?? null,
                        mentions: mentions ?? null,
                        file: meta ?? null,
                        createdAt: new Date(now).toISOString(),
                        recalledAt: null,
                    };
                },
                async list(session, limit, before) {
                    const conds = [eq(messagesSqlite.session, session)];
                    if (before)
                        conds.push(
                            lt(
                                messagesSqlite.createdAt,
                                new Date(before).getTime(),
                            ),
                        );
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(and(...conds))
                        .orderBy(desc(messagesSqlite.createdAt))
                        .limit(limit);
                    return rows.map(messageRowToChat).reverse();
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(eq(messagesSqlite.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row ? messageRowToChat(row) : null;
                },
                async markRecalled(id) {
                    const now = Date.now();
                    const rows = await db
                        .update(messagesSqlite)
                        .set({ recalledAt: now })
                        .where(eq(messagesSqlite.id, id))
                        .returning();
                    return rows[0]?.recalledAt
                        ? new Date(rows[0].recalledAt).toISOString()
                        : null;
                },
            };

            accounts = {
                async create(username, passwordHash) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    const first = (await accounts.count()) === 0;
                    await db.insert(usersSqlite).values({
                        id,
                        username,
                        passwordHash,
                        createdAt: now,
                        isAdmin: first,
                        banned: false,
                    });
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
                    const row = await this.fullById(id);
                    if (!row) return null;
                    const { passwordHash: _hash, ...user } = row;
                    return user;
                },
                async fullById(id) {
                    const rows = await db
                        .select()
                        .from(usersSqlite)
                        .where(eq(usersSqlite.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row ? userToRow(row) : null;
                },
                async byIds(ids) {
                    if (ids.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(usersSqlite)
                        .where(inArray(usersSqlite.id, ids));
                    return rows.map((row) => ({
                        id: row.id,
                        username: row.username,
                        createdAt: toIso(row.createdAt),
                    }));
                },
                async listAll() {
                    const rows = await db.select().from(usersSqlite);
                    return rows.map(
                        (row): AdminUserRow => ({
                            id: row.id,
                            username: row.username,
                            createdAt: toIso(row.createdAt),
                            isAdmin: row.isAdmin,
                            banned: row.banned,
                        }),
                    );
                },
                async setFlag(id, flag, value) {
                    await db
                        .update(usersSqlite)
                        .set(
                            flag === "isAdmin"
                                ? { isAdmin: value }
                                : { banned: value },
                        )
                        .where(eq(usersSqlite.id, id));
                },
                async count() {
                    const rows = await db
                        .select({ id: usersSqlite.id })
                        .from(usersSqlite);
                    return rows.length;
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

            groups = {
                async create(name, ownerId) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    await db
                        .insert(groupsSqlite)
                        .values({ id, name, ownerId, createdAt: now });
                    return {
                        id,
                        name,
                        ownerId,
                        notice: "",
                        muteAll: false,
                        createdAt: new Date(now).toISOString(),
                    };
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(groupsSqlite)
                        .where(eq(groupsSqlite.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row ? groupToRow(row) : null;
                },
                async remove(id) {
                    await db
                        .delete(groupMembersSqlite)
                        .where(eq(groupMembersSqlite.groupId, id));
                    await db
                        .delete(groupsSqlite)
                        .where(eq(groupsSqlite.id, id));
                    await db
                        .delete(readsSqlite)
                        .where(eq(readsSqlite.session, `g:${id}`));
                },
                async rename(id, name) {
                    await db
                        .update(groupsSqlite)
                        .set({ name })
                        .where(eq(groupsSqlite.id, id));
                },
                async setNotice(id, notice) {
                    await db
                        .update(groupsSqlite)
                        .set({ notice })
                        .where(eq(groupsSqlite.id, id));
                },
                async setMuteAll(id, on) {
                    await db
                        .update(groupsSqlite)
                        .set({ muteAll: on })
                        .where(eq(groupsSqlite.id, id));
                },
                async addMember(groupId, userId) {
                    await db
                        .insert(groupMembersSqlite)
                        .values({
                            groupId,
                            userId,
                            role: "member",
                            muted: false,
                            joinedAt: Date.now(),
                        })
                        .onConflictDoNothing();
                },
                async removeMember(groupId, userId) {
                    await db
                        .delete(groupMembersSqlite)
                        .where(
                            and(
                                eq(groupMembersSqlite.groupId, groupId),
                                eq(groupMembersSqlite.userId, userId),
                            ),
                        );
                },
                async setRole(groupId, userId, role) {
                    await db
                        .update(groupMembersSqlite)
                        .set({ role })
                        .where(
                            and(
                                eq(groupMembersSqlite.groupId, groupId),
                                eq(groupMembersSqlite.userId, userId),
                            ),
                        );
                },
                async setMuted(groupId, userId, muted) {
                    await db
                        .update(groupMembersSqlite)
                        .set({ muted })
                        .where(
                            and(
                                eq(groupMembersSqlite.groupId, groupId),
                                eq(groupMembersSqlite.userId, userId),
                            ),
                        );
                },
                async membersOf(groupId) {
                    const rows = await db
                        .select()
                        .from(groupMembersSqlite)
                        .where(eq(groupMembersSqlite.groupId, groupId));
                    return rows.map(
                        (row): GroupMemberRow => ({
                            userId: row.userId,
                            role: row.role as GroupRole,
                            muted: row.muted,
                            joinedAt: toIso(row.joinedAt),
                        }),
                    );
                },
                async memberIdsOf(groupId) {
                    const rows = await db
                        .select({ userId: groupMembersSqlite.userId })
                        .from(groupMembersSqlite)
                        .where(eq(groupMembersSqlite.groupId, groupId));
                    return rows.map((row) => row.userId);
                },
                async groupsOf(userId) {
                    const memberRows = await db
                        .select({ groupId: groupMembersSqlite.groupId })
                        .from(groupMembersSqlite)
                        .where(eq(groupMembersSqlite.userId, userId));
                    if (memberRows.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(groupsSqlite)
                        .where(
                            inArray(
                                groupsSqlite.id,
                                memberRows.map((row) => row.groupId),
                            ),
                        );
                    return rows.map(groupToRow);
                },
                async listAll() {
                    const rows = await db.select().from(groupsSqlite);
                    const memberRows = await db
                        .select({ groupId: groupMembersSqlite.groupId })
                        .from(groupMembersSqlite);
                    return rows.map((row) => ({
                        ...groupToRow(row),
                        memberCount: memberRows.filter(
                            (m) => m.groupId === row.id,
                        ).length,
                    }));
                },
                async shareGroup(aId, bId) {
                    const rows = await db
                        .select({ groupId: groupMembersSqlite.groupId })
                        .from(groupMembersSqlite)
                        .where(eq(groupMembersSqlite.userId, aId));
                    const groupIds = rows.map((row) => row.groupId);
                    if (groupIds.length === 0) return false;
                    const common = await db
                        .select({ groupId: groupMembersSqlite.groupId })
                        .from(groupMembersSqlite)
                        .where(
                            and(
                                inArray(groupMembersSqlite.groupId, groupIds),
                                eq(groupMembersSqlite.userId, bId),
                            ),
                        );
                    return common.length > 0;
                },
            };

            reads = {
                async set(userId, session, at) {
                    await db
                        .insert(readsSqlite)
                        .values({
                            userId,
                            session,
                            readAt: Date.parse(at),
                        })
                        .onConflictDoUpdate({
                            target: [readsSqlite.userId, readsSqlite.session],
                            set: { readAt: Date.parse(at) },
                        });
                },
                async ofSession(session) {
                    const rows = await db
                        .select()
                        .from(readsSqlite)
                        .where(eq(readsSqlite.session, session));
                    return rows.map((row) => ({
                        userId: row.userId,
                        at: new Date(row.readAt).toISOString(),
                    }));
                },
            };

            settings = {
                async get(key) {
                    const rows = await db
                        .select()
                        .from(settingsSqlite)
                        .where(eq(settingsSqlite.key, key))
                        .limit(1);
                    return rows[0]?.value ?? null;
                },
                async set(key, value) {
                    await db
                        .insert(settingsSqlite)
                        .values({ key, value })
                        .onConflictDoUpdate({
                            target: settingsSqlite.key,
                            set: { value },
                        });
                },
            };

            ctx.log.info(`storage driver: sqlite (${file})`);
        }

        ctx.provide<MessageStore>("store", store);
        ctx.provide<AccountsStore>("accounts", accounts);
        ctx.provide<FriendsStore>("friendships", friends);
        ctx.provide<GroupsStore>("groups", groups);
        ctx.provide<ReadsStore>("reads", reads);
        ctx.provide<SettingsStore>("settings", settings);
        return undefined;
    },
};
