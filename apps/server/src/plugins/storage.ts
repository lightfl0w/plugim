import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@plugim/core";
import type {
    FileMeta,
    GroupRole,
    LinkPreview,
    MessageQuote,
    MomentVisibility,
} from "@plugim/protocol";
import Database from "better-sqlite3";
import {
    and,
    asc,
    desc,
    eq,
    exists,
    gt,
    gte,
    inArray,
    isNull,
    lt,
    ne,
    notExists,
    or,
    sql,
} from "drizzle-orm";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import {
    boolean as pgBoolean,
    integer as pgInteger,
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
    EssenceItemRow,
    EssencesStore,
    FriendEdge,
    FriendsStore,
    GroupFileRow,
    GroupFilesStore,
    GroupMemberRow,
    GroupRow,
    GroupsStore,
    JoinRequestRow,
    JoinRequestsStore,
    MediaFileRow,
    MediaFilesStore,
    MessageStore,
    MessageTrendPoint,
    MomentCommentRow,
    MomentLikeRow,
    MomentRow,
    MomentsStore,
    PushStore,
    PushSubscriptionRow,
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
    link: sqliteText("link"),
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
    link: pgText("link"),
});

const usersSqlite = sqliteTable("users", {
    id: sqliteText("id").primaryKey(),
    username: sqliteText("username").notNull().unique(),
    passwordHash: sqliteText("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    tokenVersion: integer("token_version").notNull().default(0),
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
    tokenVersion: pgInteger("token_version").notNull().default(0),
});

const groupsSqlite = sqliteTable("groups", {
    id: sqliteText("id").primaryKey(),
    name: sqliteText("name").notNull(),
    ownerId: sqliteText("owner_id").notNull(),
    notice: sqliteText("notice").notNull().default(""),
    muteAll: integer("mute_all", { mode: "boolean" }).notNull().default(false),
    noFriendAdd: integer("no_friend_add", { mode: "boolean" })
        .notNull()
        .default(false),
    inviteCode: sqliteText("invite_code"),
    inviteExpiresAt: integer("invite_expires_at"),
    joinApproval: integer("join_approval", { mode: "boolean" })
        .notNull()
        .default(true),
    createdAt: integer("created_at").notNull(),
});

const groupsPg = pgTable("groups", {
    id: pgText("id").primaryKey(),
    name: pgText("name").notNull(),
    ownerId: pgText("owner_id").notNull(),
    notice: pgText("notice").notNull().default(""),
    muteAll: pgBoolean("mute_all").notNull().default(false),
    noFriendAdd: pgBoolean("no_friend_add").notNull().default(false),
    inviteCode: pgText("invite_code"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    joinApproval: pgBoolean("join_approval").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const joinRequestsSqlite = sqliteTable(
    "group_join_requests",
    {
        groupId: sqliteText("group_id").notNull(),
        userId: sqliteText("user_id").notNull(),
        message: sqliteText("message").notNull().default(""),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

const joinRequestsPg = pgTable(
    "group_join_requests",
    {
        groupId: pgText("group_id").notNull(),
        userId: pgText("user_id").notNull(),
        message: pgText("message").notNull().default(""),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [pgPrimaryKey({ columns: [table.groupId, table.userId] })],
);

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

const friendRemarksSqlite = sqliteTable(
    "friend_remarks",
    {
        ownerId: sqliteText("owner_id").notNull(),
        friendId: sqliteText("friend_id").notNull(),
        remark: sqliteText("remark").notNull(),
    },
    (table) => [primaryKey({ columns: [table.ownerId, table.friendId] })],
);

const friendRemarksPg = pgTable(
    "friend_remarks",
    {
        ownerId: pgText("owner_id").notNull(),
        friendId: pgText("friend_id").notNull(),
        remark: pgText("remark").notNull(),
    },
    (table) => [pgPrimaryKey({ columns: [table.ownerId, table.friendId] })],
);

const friendGroupsSqlite = sqliteTable("friend_groups", {
    id: sqliteText("id").primaryKey(),
    ownerId: sqliteText("owner_id").notNull(),
    name: sqliteText("name").notNull(),
    createdAt: integer("created_at").notNull(),
});

const friendGroupsPg = pgTable("friend_groups", {
    id: pgText("id").primaryKey(),
    ownerId: pgText("owner_id").notNull(),
    name: pgText("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const friendGroupMembersSqlite = sqliteTable(
    "friend_group_members",
    {
        ownerId: sqliteText("owner_id").notNull(),
        friendId: sqliteText("friend_id").notNull(),
        groupId: sqliteText("group_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.ownerId, table.friendId] })],
);

const friendGroupMembersPg = pgTable(
    "friend_group_members",
    {
        ownerId: pgText("owner_id").notNull(),
        friendId: pgText("friend_id").notNull(),
        groupId: pgText("group_id").notNull(),
    },
    (table) => [pgPrimaryKey({ columns: [table.ownerId, table.friendId] })],
);

const essencesSqlite = sqliteTable(
    "essences",
    {
        groupId: sqliteText("group_id").notNull(),
        messageId: sqliteText("message_id").notNull(),
        setBy: sqliteText("set_by").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.messageId] })],
);

const essencesPg = pgTable(
    "essences",
    {
        groupId: pgText("group_id").notNull(),
        messageId: pgText("message_id").notNull(),
        setBy: pgText("set_by").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [pgPrimaryKey({ columns: [table.groupId, table.messageId] })],
);

const settingsSqlite = sqliteTable("settings", {
    key: sqliteText("key").primaryKey(),
    value: sqliteText("value").notNull(),
});

const settingsPg = pgTable("settings", {
    key: pgText("key").primaryKey(),
    value: pgText("value").notNull(),
});

const pushSqlite = sqliteTable("push_subscriptions", {
    endpoint: sqliteText("endpoint").primaryKey(),
    userId: sqliteText("user_id").notNull(),
    p256dh: sqliteText("p256dh").notNull(),
    auth: sqliteText("auth").notNull(),
    createdAt: integer("created_at").notNull(),
});

const pushPg = pgTable("push_subscriptions", {
    endpoint: pgText("endpoint").primaryKey(),
    userId: pgText("user_id").notNull(),
    p256dh: pgText("p256dh").notNull(),
    auth: pgText("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const mediaFilesSqlite = sqliteTable("media_files", {
    key: sqliteText("key").primaryKey(),
    name: sqliteText("name").notNull(),
    mime: sqliteText("mime").notNull(),
    size: integer("size").notNull(),
    uploaderId: sqliteText("uploader_id").notNull(),
    createdAt: integer("created_at").notNull(),
});

const mediaFilesPg = pgTable("media_files", {
    key: pgText("key").primaryKey(),
    name: pgText("name").notNull(),
    mime: pgText("mime").notNull(),
    size: pgInteger("size").notNull(),
    uploaderId: pgText("uploader_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const groupFilesSqlite = sqliteTable(
    "group_files",
    {
        groupId: sqliteText("group_id").notNull(),
        key: sqliteText("key").notNull(),
        name: sqliteText("name").notNull(),
        mime: sqliteText("mime").notNull(),
        size: integer("size").notNull(),
        uploaderId: sqliteText("uploader_id").notNull(),
        createdAt: integer("created_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.key] })],
);

const groupFilesPg = pgTable(
    "group_files",
    {
        groupId: pgText("group_id").notNull(),
        key: pgText("key").notNull(),
        name: pgText("name").notNull(),
        mime: pgText("mime").notNull(),
        size: pgInteger("size").notNull(),
        uploaderId: pgText("uploader_id").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [pgPrimaryKey({ columns: [table.groupId, table.key] })],
);

const momentsSqlite = sqliteTable("moments", {
    id: sqliteText("id").primaryKey(),
    authorId: sqliteText("author_id").notNull(),
    content: sqliteText("content").notNull(),
    images: sqliteText("images").notNull(),
    video: sqliteText("video"),
    link: sqliteText("link"),
    visibility: sqliteText("visibility").notNull(),
    createdAt: integer("created_at").notNull(),
});

const momentsPg = pgTable("moments", {
    id: pgText("id").primaryKey(),
    authorId: pgText("author_id").notNull(),
    content: pgText("content").notNull(),
    images: pgText("images").notNull(),
    video: pgText("video"),
    link: pgText("link"),
    visibility: pgText("visibility").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const momentAudienceSqlite = sqliteTable(
    "moment_audience",
    {
        postId: sqliteText("post_id").notNull(),
        userId: sqliteText("user_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.postId, table.userId] })],
);

const momentAudiencePg = pgTable(
    "moment_audience",
    {
        postId: pgText("post_id").notNull(),
        userId: pgText("user_id").notNull(),
    },
    (table) => [pgPrimaryKey({ columns: [table.postId, table.userId] })],
);

const momentReadsSqlite = sqliteTable("moment_reads", {
    userId: sqliteText("user_id").primaryKey(),
    seenAt: integer("seen_at").notNull(),
});

const momentReadsPg = pgTable("moment_reads", {
    userId: pgText("user_id").primaryKey(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
});

const momentLikesSqlite = sqliteTable(
    "moment_likes",
    {
        postId: sqliteText("post_id").notNull(),
        userId: sqliteText("user_id").notNull(),
        at: integer("at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.postId, table.userId] })],
);

const momentLikesPg = pgTable(
    "moment_likes",
    {
        postId: pgText("post_id").notNull(),
        userId: pgText("user_id").notNull(),
        at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [pgPrimaryKey({ columns: [table.postId, table.userId] })],
);

const momentCommentsSqlite = sqliteTable("moment_comments", {
    id: sqliteText("id").primaryKey(),
    postId: sqliteText("post_id").notNull(),
    authorId: sqliteText("author_id").notNull(),
    content: sqliteText("content").notNull(),
    createdAt: integer("created_at").notNull(),
});

const momentCommentsPg = pgTable("moment_comments", {
    id: pgText("id").primaryKey(),
    postId: pgText("post_id").notNull(),
    authorId: pgText("author_id").notNull(),
    content: pgText("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
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
  file TEXT,
  link TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS friend_remarks (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friend_group_members (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS essences (
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, message_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  mute_all INTEGER NOT NULL DEFAULT 0,
  no_friend_add INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT,
  invite_expires_at INTEGER,
  join_approval INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_join_requests (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
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
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS media_files (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_files (
  group_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, key)
);
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT NOT NULL,
  video TEXT,
  link TEXT,
  visibility TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moments_created_idx ON moments (created_at);
CREATE TABLE IF NOT EXISTS moment_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS moment_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS moment_comments_post_idx ON moment_comments (post_id, created_at);
CREATE TABLE IF NOT EXISTS moment_audience (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS moment_audience_user_idx ON moment_audience (user_id);
CREATE TABLE IF NOT EXISTS moment_reads (
  user_id TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
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
  file TEXT,
  link TEXT
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  token_version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS friend_remarks (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_groups (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS friend_group_members (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS essences (
  group_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  set_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, message_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  mute_all BOOLEAN NOT NULL DEFAULT FALSE,
  no_friend_add BOOLEAN NOT NULL DEFAULT FALSE,
  invite_code TEXT,
  invite_expires_at TIMESTAMPTZ,
  join_approval BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_join_requests (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
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
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS media_files (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_files (
  group_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, key)
);
CREATE TABLE IF NOT EXISTS moments (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  images TEXT NOT NULL,
  video TEXT,
  link TEXT,
  visibility TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moments_created_idx ON moments (created_at);
CREATE TABLE IF NOT EXISTS moment_likes (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
CREATE TABLE IF NOT EXISTS moment_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moment_comments_post_idx ON moment_comments (post_id, created_at);
CREATE TABLE IF NOT EXISTS moment_audience (
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS moment_audience_user_idx ON moment_audience (user_id);
CREATE TABLE IF NOT EXISTS moment_reads (
  user_id TEXT PRIMARY KEY,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
            return {
                name: parsed.name,
                size: parsed.size,
                ...(typeof parsed.mime === "string"
                    ? { mime: parsed.mime }
                    : {}),
            };
    } catch {}
    return null;
};

const parseImages = (raw: string): string[] => {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed))
            return parsed.filter(
                (item): item is string => typeof item === "string",
            );
    } catch {}
    return [];
};

const toVisibility = (value: string): MomentVisibility =>
    value === "friends" || value === "partial" || value === "exclude"
        ? value
        : "public";

const parseLink = (raw: unknown): LinkPreview | null => {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<LinkPreview>;
        if (
            typeof parsed?.url === "string" &&
            typeof parsed?.title === "string"
        )
            return {
                url: parsed.url,
                title: parsed.title,
                description:
                    typeof parsed.description === "string"
                        ? parsed.description
                        : "",
                image: typeof parsed.image === "string" ? parsed.image : null,
                site: typeof parsed.site === "string" ? parsed.site : "",
            };
    } catch {}
    return null;
};

const momentToRow = (row: {
    id: string;
    authorId: string;
    content: string;
    images: string;
    video: string | null;
    link: string | null;
    visibility: string;
    createdAt: Date | number;
}): MomentRow => ({
    id: row.id,
    authorId: row.authorId,
    content: row.content,
    images: parseImages(row.images),
    video: row.video ?? null,
    link: parseLink(row.link),
    visibility: toVisibility(row.visibility),
    audience: [],
    createdAt: toIso(row.createdAt),
});

const momentLikeToRow = (row: {
    postId: string;
    userId: string;
    at: Date | number;
}): MomentLikeRow => ({
    postId: row.postId,
    userId: row.userId,
    at: toIso(row.at),
});

const momentCommentToRow = (row: {
    id: string;
    postId: string;
    authorId: string;
    content: string;
    createdAt: Date | number;
}): MomentCommentRow => ({
    id: row.id,
    postId: row.postId,
    authorId: row.authorId,
    content: row.content,
    createdAt: toIso(row.createdAt),
});

const mediaFileToRow = (row: {
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderId: string;
    createdAt: Date | number;
}): MediaFileRow => ({
    key: row.key,
    name: row.name,
    mime: row.mime,
    size: row.size,
    uploaderId: row.uploaderId,
    createdAt: toIso(row.createdAt),
});

const groupFileToRow = (row: {
    groupId: string;
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderId: string;
    createdAt: Date | number;
}): GroupFileRow => ({
    groupId: row.groupId,
    key: row.key,
    name: row.name,
    mime: row.mime,
    size: row.size,
    uploaderId: row.uploaderId,
    createdAt: toIso(row.createdAt),
});

const CHART_DAYS_MAX = 90;

const localDayKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const fillTrend = (
    rows: { date: string; messages: number; senders: number }[],
    days: number,
): MessageTrendPoint[] => {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const out: MessageTrendPoint[] = [];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    for (let i = 0; i < days; i++) {
        const day = new Date(start);
        day.setDate(start.getDate() + i);
        const key = localDayKey(day);
        const hit = byDate.get(key);
        out.push({
            date: key,
            messages: Number(hit?.messages ?? 0),
            senders: Number(hit?.senders ?? 0),
        });
    }
    return out;
};

const trendDays = (days: number) =>
    Math.min(Math.max(Math.floor(days) || 14, 1), CHART_DAYS_MAX);

const trendStart = (days: number) => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (days - 1));
    return start;
};

const escapeLike = (value: string) =>
    value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const likeKeyword = (col: unknown, keyword: string) =>
    sql`${col} LIKE ${`%${escapeLike(keyword)}%`} ESCAPE '\\'`;

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
    link: string | null;
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
    link: parseLink(row.link),
});

export const storagePlugin: Plugin = {
    name: "storage",
    description: "存储驱动(sqlite / postgres)",
    provides: [
        "store",
        "accounts",
        "friendships",
        "groups",
        "essences",
        "reads",
        "settings",
        "pushes",
        "mediaFiles",
        "groupFiles",
        "join-requests",
        "moments",
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
        let pushes: PushStore;
        let mediaFiles: MediaFilesStore;
        let groupFiles: GroupFilesStore;
        let joinRequests: JoinRequestsStore;
        let moments: MomentsStore;
        let essences: EssencesStore;

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
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS link TEXT",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE",
            );
            await client.unsafe(
                "ALTER TABLE groups ADD COLUMN IF NOT EXISTS no_friend_add BOOLEAN NOT NULL DEFAULT FALSE",
            );
            await client.unsafe(
                "ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code TEXT",
            );
            await client.unsafe(
                "ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ",
            );
            await client.unsafe(
                "ALTER TABLE groups ADD COLUMN IF NOT EXISTS join_approval BOOLEAN NOT NULL DEFAULT TRUE",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0",
            );
            await client.unsafe(
                "ALTER TABLE moments ADD COLUMN IF NOT EXISTS video TEXT",
            );
            await client.unsafe(
                "ALTER TABLE moments ADD COLUMN IF NOT EXISTS link TEXT",
            );
            const db = drizzlePg(client);

            const messageCursor = async (id: string) => {
                const rows = await db
                    .select({
                        id: messagesPg.id,
                        createdAt: messagesPg.createdAt,
                    })
                    .from(messagesPg)
                    .where(eq(messagesPg.id, id))
                    .limit(1);
                const row = rows[0];
                return row ? { id: row.id, at: row.createdAt } : null;
            };
            const olderThan = (at: Date, id: string) =>
                sql`(${messagesPg.createdAt} < ${at} OR (${messagesPg.createdAt} = ${at} AND ${messagesPg.id} <= ${id}))`;
            const newerThan = (at: Date, id: string) =>
                sql`(${messagesPg.createdAt} > ${at} OR (${messagesPg.createdAt} = ${at} AND ${messagesPg.id} >= ${id}))`;

            const userToRow = (
                row: typeof usersPg.$inferSelect,
            ): UserWithHash => ({
                id: row.id,
                username: row.username,
                passwordHash: row.passwordHash,
                createdAt: toIso(row.createdAt),
                isAdmin: row.isAdmin,
                banned: row.banned,
                tokenVersion: row.tokenVersion,
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
                noFriendAdd: row.noFriendAdd,
                inviteCode: row.inviteCode,
                inviteExpiresAt: row.inviteExpiresAt
                    ? toIso(row.inviteExpiresAt)
                    : null,
                joinApproval: row.joinApproval,
                createdAt: toIso(row.createdAt),
            });
            const pushToRow = (
                row: typeof pushPg.$inferSelect,
            ): PushSubscriptionRow => ({
                userId: row.userId,
                endpoint: row.endpoint,
                p256dh: row.p256dh,
                auth: row.auth,
                createdAt: toIso(row.createdAt),
            });

            store = {
                async save(input) {
                    const id = crypto.randomUUID();
                    const { quote, mentions, file, link, ...rest } = input;
                    const rows = await db
                        .insert(messagesPg)
                        .values({
                            id,
                            ...rest,
                            quote: serializeQuote(quote),
                            mentions: serializeMentions(mentions),
                            file: file ? JSON.stringify(file) : null,
                            link: link ? JSON.stringify(link) : null,
                        })
                        .returning();
                    return messageRowToChat(rows[0]);
                },
                async list(session, limit, before, after, beforeId, afterId) {
                    const conds = [eq(messagesPg.session, session)];
                    const older = beforeId
                        ? await messageCursor(beforeId)
                        : null;
                    const newer = afterId ? await messageCursor(afterId) : null;
                    if (older) conds.push(olderThan(older.at, older.id));
                    else if (before)
                        conds.push(lt(messagesPg.createdAt, new Date(before)));
                    if (newer) conds.push(newerThan(newer.at, newer.id));
                    else if (after)
                        conds.push(gt(messagesPg.createdAt, new Date(after)));
                    const forward = Boolean(newer) || Boolean(!older && after);
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(and(...conds))
                        .orderBy(
                            forward
                                ? asc(messagesPg.createdAt)
                                : desc(messagesPg.createdAt),
                            forward ? asc(messagesPg.id) : desc(messagesPg.id),
                        )
                        .limit(limit);
                    const list = rows.map(messageRowToChat);
                    return forward ? list : list.reverse();
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
                async search(params) {
                    const conds = [isNull(messagesPg.recalledAt)];
                    if (params.session)
                        conds.push(eq(messagesPg.session, params.session));
                    if (params.sessions) {
                        if (params.sessions.length === 0)
                            return { rows: [], total: 0 };
                        conds.push(
                            inArray(messagesPg.session, params.sessions),
                        );
                    }
                    if (params.sender)
                        conds.push(eq(messagesPg.sender, params.sender));
                    if (params.media) conds.push(ne(messagesPg.kind, "text"));
                    if (params.keyword)
                        conds.push(
                            likeKeyword(messagesPg.content, params.keyword),
                        );
                    const where = and(...conds);
                    const counted = await db
                        .select({ id: messagesPg.id })
                        .from(messagesPg)
                        .where(where);
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(where)
                        .orderBy(desc(messagesPg.createdAt))
                        .limit(params.limit)
                        .offset(params.offset);
                    return {
                        rows: rows.map(messageRowToChat),
                        total: counted.length,
                    };
                },
                async deleteOlderThan(iso) {
                    const rows = await db
                        .delete(messagesPg)
                        .where(lt(messagesPg.createdAt, new Date(iso)))
                        .returning();
                    return rows.map(messageRowToChat);
                },
                async countByContent(content) {
                    const rows = await db
                        .select({ id: messagesPg.id })
                        .from(messagesPg)
                        .where(eq(messagesPg.content, content));
                    return rows.length;
                },
                async trend(days) {
                    const count = trendDays(days);
                    const dayExpr = sql<string>`to_char(${messagesPg.createdAt}, 'YYYY-MM-DD')`;
                    const rows = await db
                        .select({
                            date: dayExpr,
                            messages: sql<number>`count(*)`,
                            senders: sql<number>`count(distinct ${messagesPg.sender})`,
                        })
                        .from(messagesPg)
                        .where(gte(messagesPg.createdAt, trendStart(count)))
                        .groupBy(dayExpr)
                        .orderBy(dayExpr);
                    return fillTrend(rows, count);
                },
                async count() {
                    const rows = await db
                        .select({ id: messagesPg.id })
                        .from(messagesPg);
                    return rows.length;
                },
                async mediaBytes() {
                    const rows = await db
                        .select({
                            total: sql<number>`coalesce(sum(octet_length(${messagesPg.content})), 0)`,
                        })
                        .from(messagesPg)
                        .where(ne(messagesPg.kind, "text"));
                    return Number(rows[0]?.total ?? 0);
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
                async setPassword(id, passwordHash) {
                    const rows = await db
                        .select({ version: usersPg.tokenVersion })
                        .from(usersPg)
                        .where(eq(usersPg.id, id))
                        .limit(1);
                    const version = (rows[0]?.version ?? 0) + 1;
                    await db
                        .update(usersPg)
                        .set({ passwordHash, tokenVersion: version })
                        .where(eq(usersPg.id, id));
                    return version;
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
                async setRemark(ownerId, friendId, remark) {
                    if (!remark) {
                        await db
                            .delete(friendRemarksPg)
                            .where(
                                and(
                                    eq(friendRemarksPg.ownerId, ownerId),
                                    eq(friendRemarksPg.friendId, friendId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(friendRemarksPg)
                        .values({ ownerId, friendId, remark })
                        .onConflictDoUpdate({
                            target: [
                                friendRemarksPg.ownerId,
                                friendRemarksPg.friendId,
                            ],
                            set: { remark },
                        });
                },
                async remarksOf(ownerId) {
                    const rows = await db
                        .select()
                        .from(friendRemarksPg)
                        .where(eq(friendRemarksPg.ownerId, ownerId));
                    const result: Record<string, string> = {};
                    for (const row of rows) result[row.friendId] = row.remark;
                    return result;
                },
                async groupListOf(ownerId) {
                    const rows = await db
                        .select()
                        .from(friendGroupsPg)
                        .where(eq(friendGroupsPg.ownerId, ownerId))
                        .orderBy(asc(friendGroupsPg.createdAt));
                    return rows.map((row) => ({
                        id: row.id,
                        ownerId: row.ownerId,
                        name: row.name,
                        createdAt: toIso(row.createdAt),
                    }));
                },
                async groupCreate(ownerId, name) {
                    const rows = await db
                        .insert(friendGroupsPg)
                        .values({ id: crypto.randomUUID(), ownerId, name })
                        .returning();
                    const row = rows[0];
                    return {
                        id: row.id,
                        ownerId: row.ownerId,
                        name: row.name,
                        createdAt: toIso(row.createdAt),
                    };
                },
                async groupRename(ownerId, groupId, name) {
                    await db
                        .update(friendGroupsPg)
                        .set({ name })
                        .where(
                            and(
                                eq(friendGroupsPg.id, groupId),
                                eq(friendGroupsPg.ownerId, ownerId),
                            ),
                        );
                },
                async groupRemove(ownerId, groupId) {
                    await db
                        .delete(friendGroupsPg)
                        .where(
                            and(
                                eq(friendGroupsPg.id, groupId),
                                eq(friendGroupsPg.ownerId, ownerId),
                            ),
                        );
                    await db
                        .delete(friendGroupMembersPg)
                        .where(
                            and(
                                eq(friendGroupMembersPg.ownerId, ownerId),
                                eq(friendGroupMembersPg.groupId, groupId),
                            ),
                        );
                },
                async groupSetFriend(ownerId, friendId, groupId) {
                    if (!groupId) {
                        await db
                            .delete(friendGroupMembersPg)
                            .where(
                                and(
                                    eq(friendGroupMembersPg.ownerId, ownerId),
                                    eq(friendGroupMembersPg.friendId, friendId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(friendGroupMembersPg)
                        .values({ ownerId, friendId, groupId })
                        .onConflictDoUpdate({
                            target: [
                                friendGroupMembersPg.ownerId,
                                friendGroupMembersPg.friendId,
                            ],
                            set: { groupId },
                        });
                },
                async friendGroupMap(ownerId) {
                    const rows = await db
                        .select()
                        .from(friendGroupMembersPg)
                        .where(eq(friendGroupMembersPg.ownerId, ownerId));
                    const result: Record<string, string> = {};
                    for (const row of rows) result[row.friendId] = row.groupId;
                    return result;
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
                async byInviteCode(code) {
                    const rows = await db
                        .select()
                        .from(groupsPg)
                        .where(eq(groupsPg.inviteCode, code))
                        .limit(1);
                    const row = rows[0];
                    return row ? groupToRow(row) : null;
                },
                async remove(id) {
                    await db
                        .delete(groupMembersPg)
                        .where(eq(groupMembersPg.groupId, id));
                    await db
                        .delete(joinRequestsPg)
                        .where(eq(joinRequestsPg.groupId, id));
                    await db
                        .delete(groupFilesPg)
                        .where(eq(groupFilesPg.groupId, id));
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
                async setNoFriendAdd(id, on) {
                    await db
                        .update(groupsPg)
                        .set({ noFriendAdd: on })
                        .where(eq(groupsPg.id, id));
                },
                async setInvite(id, code, expiresAt) {
                    await db
                        .update(groupsPg)
                        .set({
                            inviteCode: code,
                            inviteExpiresAt: expiresAt
                                ? new Date(expiresAt)
                                : null,
                        })
                        .where(eq(groupsPg.id, id));
                },
                async setJoinApproval(id, on) {
                    await db
                        .update(groupsPg)
                        .set({ joinApproval: on })
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
                async friendAddBlocked(aId, bId) {
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
                    const commonIds = common.map((row) => row.groupId);
                    if (commonIds.length === 0) return false;
                    const blocked = await db
                        .select({ id: groupsPg.id })
                        .from(groupsPg)
                        .where(
                            and(
                                inArray(groupsPg.id, commonIds),
                                eq(groupsPg.noFriendAdd, true),
                            ),
                        );
                    return blocked.length > 0;
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

            pushes = {
                async save(input) {
                    await db
                        .insert(pushPg)
                        .values(input)
                        .onConflictDoUpdate({
                            target: pushPg.endpoint,
                            set: {
                                userId: input.userId,
                                p256dh: input.p256dh,
                                auth: input.auth,
                            },
                        });
                },
                async remove(endpoint) {
                    await db
                        .delete(pushPg)
                        .where(eq(pushPg.endpoint, endpoint));
                },
                async ofUser(userId) {
                    const rows = await db
                        .select()
                        .from(pushPg)
                        .where(eq(pushPg.userId, userId));
                    return rows.map(pushToRow);
                },
                async ofUsers(userIds) {
                    if (userIds.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(pushPg)
                        .where(inArray(pushPg.userId, userIds));
                    return rows.map(pushToRow);
                },
                async ofAll() {
                    const rows = await db.select().from(pushPg);
                    return rows.map(pushToRow);
                },
            };

            mediaFiles = {
                async save(row) {
                    await db
                        .insert(mediaFilesPg)
                        .values({ ...row, createdAt: new Date(row.createdAt) })
                        .onConflictDoUpdate({
                            target: mediaFilesPg.key,
                            set: {
                                name: row.name,
                                mime: row.mime,
                                size: row.size,
                            },
                        });
                },
                async byKey(key) {
                    const rows = await db
                        .select()
                        .from(mediaFilesPg)
                        .where(eq(mediaFilesPg.key, key))
                        .limit(1);
                    return rows[0] ? mediaFileToRow(rows[0]) : null;
                },
                async list({ offset, limit }) {
                    const all = await db
                        .select({ key: mediaFilesPg.key })
                        .from(mediaFilesPg);
                    const rows = await db
                        .select()
                        .from(mediaFilesPg)
                        .orderBy(desc(mediaFilesPg.createdAt))
                        .limit(limit)
                        .offset(offset);
                    return {
                        rows: rows.map(mediaFileToRow),
                        total: all.length,
                    };
                },
                async olderThan(iso) {
                    const rows = await db
                        .select()
                        .from(mediaFilesPg)
                        .where(lt(mediaFilesPg.createdAt, new Date(iso)));
                    return rows.map(mediaFileToRow);
                },
                async totalBytes() {
                    const rows = await db
                        .select({
                            total: sql<number>`coalesce(sum(${mediaFilesPg.size}), 0)`,
                        })
                        .from(mediaFilesPg);
                    return Number(rows[0]?.total ?? 0);
                },
                async count() {
                    const rows = await db
                        .select({ key: mediaFilesPg.key })
                        .from(mediaFilesPg);
                    return rows.length;
                },
                async remove(key) {
                    await db
                        .delete(mediaFilesPg)
                        .where(eq(mediaFilesPg.key, key));
                },
            };

            groupFiles = {
                async save(row) {
                    await db
                        .insert(groupFilesPg)
                        .values({ ...row, createdAt: new Date(row.createdAt) })
                        .onConflictDoUpdate({
                            target: [groupFilesPg.groupId, groupFilesPg.key],
                            set: {
                                name: row.name,
                                mime: row.mime,
                                size: row.size,
                            },
                        });
                },
                async byKey(groupId, key) {
                    const rows = await db
                        .select()
                        .from(groupFilesPg)
                        .where(
                            and(
                                eq(groupFilesPg.groupId, groupId),
                                eq(groupFilesPg.key, key),
                            ),
                        )
                        .limit(1);
                    return rows[0] ? groupFileToRow(rows[0]) : null;
                },
                async list(groupId, { offset, limit }) {
                    const all = await db
                        .select({ key: groupFilesPg.key })
                        .from(groupFilesPg)
                        .where(eq(groupFilesPg.groupId, groupId));
                    const rows = await db
                        .select()
                        .from(groupFilesPg)
                        .where(eq(groupFilesPg.groupId, groupId))
                        .orderBy(desc(groupFilesPg.createdAt))
                        .limit(limit)
                        .offset(offset);
                    return {
                        rows: rows.map(groupFileToRow),
                        total: all.length,
                    };
                },
                async countByKey(key) {
                    const rows = await db
                        .select({ key: groupFilesPg.key })
                        .from(groupFilesPg)
                        .where(eq(groupFilesPg.key, key));
                    return rows.length;
                },
                async remove(groupId, key) {
                    await db
                        .delete(groupFilesPg)
                        .where(
                            and(
                                eq(groupFilesPg.groupId, groupId),
                                eq(groupFilesPg.key, key),
                            ),
                        );
                },
            };

            joinRequests = {
                async upsert({ groupId, userId, message }) {
                    await db
                        .insert(joinRequestsPg)
                        .values({ groupId, userId, message })
                        .onConflictDoUpdate({
                            target: [
                                joinRequestsPg.groupId,
                                joinRequestsPg.userId,
                            ],
                            set: { message, createdAt: new Date() },
                        });
                },
                async byGroup(groupId) {
                    const rows = await db
                        .select()
                        .from(joinRequestsPg)
                        .where(eq(joinRequestsPg.groupId, groupId))
                        .orderBy(joinRequestsPg.createdAt);
                    return rows.map(
                        (row): JoinRequestRow => ({
                            groupId: row.groupId,
                            userId: row.userId,
                            message: row.message,
                            createdAt: toIso(row.createdAt),
                        }),
                    );
                },
                async countByGroup(groupId) {
                    const rows = await db
                        .select({ userId: joinRequestsPg.userId })
                        .from(joinRequestsPg)
                        .where(eq(joinRequestsPg.groupId, groupId));
                    return rows.length;
                },
                async remove(groupId, userId) {
                    await db
                        .delete(joinRequestsPg)
                        .where(
                            and(
                                eq(joinRequestsPg.groupId, groupId),
                                eq(joinRequestsPg.userId, userId),
                            ),
                        );
                },
            };

            const momentVisibleFor = (viewerId: string, friendIds: string[]) =>
                or(
                    eq(momentsPg.authorId, viewerId),
                    and(
                        inArray(momentsPg.visibility, ["public", "exclude"]),
                        notExists(
                            db
                                .select()
                                .from(momentAudiencePg)
                                .where(
                                    and(
                                        eq(
                                            momentAudiencePg.postId,
                                            momentsPg.id,
                                        ),
                                        eq(momentAudiencePg.userId, viewerId),
                                    ),
                                ),
                        ),
                    ),
                    and(
                        eq(momentsPg.visibility, "partial"),
                        exists(
                            db
                                .select()
                                .from(momentAudiencePg)
                                .where(
                                    and(
                                        eq(
                                            momentAudiencePg.postId,
                                            momentsPg.id,
                                        ),
                                        eq(momentAudiencePg.userId, viewerId),
                                    ),
                                ),
                        ),
                    ),
                    ...(friendIds.length > 0
                        ? [
                              and(
                                  eq(momentsPg.visibility, "friends"),
                                  inArray(momentsPg.authorId, friendIds),
                              ),
                          ]
                        : []),
                );

            const withMomentAudience = async (
                rows: MomentRow[],
            ): Promise<MomentRow[]> => {
                const targets = rows.filter(
                    (row) =>
                        row.visibility === "partial" ||
                        row.visibility === "exclude",
                );
                if (targets.length === 0) return rows;
                const links = await db
                    .select()
                    .from(momentAudiencePg)
                    .where(
                        inArray(
                            momentAudiencePg.postId,
                            targets.map((row) => row.id),
                        ),
                    );
                const byPost = new Map<string, string[]>();
                for (const link of links) {
                    const list = byPost.get(link.postId) ?? [];
                    list.push(link.userId);
                    byPost.set(link.postId, list);
                }
                return rows.map((row) => ({
                    ...row,
                    audience: byPost.get(row.id) ?? [],
                }));
            };

            moments = {
                async create(input) {
                    const id = crypto.randomUUID();
                    const rows = await db
                        .insert(momentsPg)
                        .values({
                            id,
                            authorId: input.authorId,
                            content: input.content,
                            images: JSON.stringify(input.images),
                            video: input.video,
                            link: input.link
                                ? JSON.stringify(input.link)
                                : null,
                            visibility: input.visibility,
                        })
                        .returning();
                    if (input.audience.length > 0)
                        await db
                            .insert(momentAudiencePg)
                            .values(
                                input.audience.map((userId) => ({
                                    postId: id,
                                    userId,
                                })),
                            )
                            .onConflictDoNothing();
                    return {
                        ...momentToRow(rows[0]),
                        audience: input.audience,
                    };
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(momentsPg)
                        .where(eq(momentsPg.id, id))
                        .limit(1);
                    if (!rows[0]) return null;
                    const [row] = await withMomentAudience([
                        momentToRow(rows[0]),
                    ]);
                    return row;
                },
                async remove(id) {
                    await db
                        .delete(momentAudiencePg)
                        .where(eq(momentAudiencePg.postId, id));
                    await db
                        .delete(momentLikesPg)
                        .where(eq(momentLikesPg.postId, id));
                    await db
                        .delete(momentCommentsPg)
                        .where(eq(momentCommentsPg.postId, id));
                    await db.delete(momentsPg).where(eq(momentsPg.id, id));
                },
                async list({
                    viewerId,
                    friendIds,
                    author,
                    before,
                    beforeId,
                    limit,
                }) {
                    const at = before ? new Date(before) : null;
                    const rows = await db
                        .select()
                        .from(momentsPg)
                        .where(
                            and(
                                momentVisibleFor(viewerId, friendIds),
                                author
                                    ? eq(momentsPg.authorId, author)
                                    : undefined,
                                at
                                    ? beforeId
                                        ? sql`(${momentsPg.createdAt} < ${at} OR (${momentsPg.createdAt} = ${at} AND ${momentsPg.id} < ${beforeId}))`
                                        : lt(momentsPg.createdAt, at)
                                    : undefined,
                            ),
                        )
                        .orderBy(desc(momentsPg.createdAt), desc(momentsPg.id))
                        .limit(limit);
                    return withMomentAudience(rows.map(momentToRow));
                },
                async audienceOf(postId) {
                    const rows = await db
                        .select()
                        .from(momentAudiencePg)
                        .where(eq(momentAudiencePg.postId, postId));
                    return rows.map((row) => row.userId);
                },
                async unread(userId, friendIds) {
                    const seenRows = await db
                        .select()
                        .from(momentReadsPg)
                        .where(eq(momentReadsPg.userId, userId))
                        .limit(1);
                    const seen = seenRows[0]?.seenAt ?? new Date(0);
                    const postRows = await db
                        .select({ n: sql<number>`count(*)` })
                        .from(momentsPg)
                        .where(
                            and(
                                gt(momentsPg.createdAt, seen),
                                ne(momentsPg.authorId, userId),
                                friendIds.length > 0
                                    ? inArray(momentsPg.authorId, friendIds)
                                    : sql`1 = 0`,
                                momentVisibleFor(userId, friendIds),
                            ),
                        );
                    const likeRows = await db
                        .select({ n: sql<number>`count(*)` })
                        .from(momentLikesPg)
                        .innerJoin(
                            momentsPg,
                            eq(momentLikesPg.postId, momentsPg.id),
                        )
                        .where(
                            and(
                                eq(momentsPg.authorId, userId),
                                ne(momentLikesPg.userId, userId),
                                gt(momentLikesPg.at, seen),
                            ),
                        );
                    const commentRows = await db
                        .select({ n: sql<number>`count(*)` })
                        .from(momentCommentsPg)
                        .innerJoin(
                            momentsPg,
                            eq(momentCommentsPg.postId, momentsPg.id),
                        )
                        .where(
                            and(
                                eq(momentsPg.authorId, userId),
                                ne(momentCommentsPg.authorId, userId),
                                gt(momentCommentsPg.createdAt, seen),
                            ),
                        );
                    return {
                        posts: Number(postRows[0]?.n ?? 0),
                        interactions:
                            Number(likeRows[0]?.n ?? 0) +
                            Number(commentRows[0]?.n ?? 0),
                    };
                },
                async markSeen(userId, at) {
                    const seenAt = new Date(at);
                    await db
                        .insert(momentReadsPg)
                        .values({ userId, seenAt })
                        .onConflictDoUpdate({
                            target: momentReadsPg.userId,
                            set: { seenAt },
                        });
                },
                async setLike(postId, userId, liked) {
                    if (!liked) {
                        await db
                            .delete(momentLikesPg)
                            .where(
                                and(
                                    eq(momentLikesPg.postId, postId),
                                    eq(momentLikesPg.userId, userId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(momentLikesPg)
                        .values({ postId, userId, at: new Date() })
                        .onConflictDoNothing();
                },
                async likesOf(postIds) {
                    if (postIds.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(momentLikesPg)
                        .where(inArray(momentLikesPg.postId, postIds))
                        .orderBy(asc(momentLikesPg.at));
                    return rows.map(momentLikeToRow);
                },
                async addComment(input) {
                    const rows = await db
                        .insert(momentCommentsPg)
                        .values({
                            id: crypto.randomUUID(),
                            postId: input.postId,
                            authorId: input.authorId,
                            content: input.content,
                            createdAt: new Date(),
                        })
                        .returning();
                    return momentCommentToRow(rows[0]);
                },
                async commentsOf(postIds) {
                    if (postIds.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(momentCommentsPg)
                        .where(inArray(momentCommentsPg.postId, postIds))
                        .orderBy(asc(momentCommentsPg.createdAt));
                    return rows.map(momentCommentToRow);
                },
            };

            essences = {
                async add(groupId, messageId, setBy) {
                    await db
                        .insert(essencesPg)
                        .values({ groupId, messageId, setBy })
                        .onConflictDoNothing();
                },
                async remove(groupId, messageId) {
                    await db
                        .delete(essencesPg)
                        .where(
                            and(
                                eq(essencesPg.groupId, groupId),
                                eq(essencesPg.messageId, messageId),
                            ),
                        );
                },
                async has(groupId, messageId) {
                    const rows = await db
                        .select({ messageId: essencesPg.messageId })
                        .from(essencesPg)
                        .where(
                            and(
                                eq(essencesPg.groupId, groupId),
                                eq(essencesPg.messageId, messageId),
                            ),
                        )
                        .limit(1);
                    return rows.length > 0;
                },
                async listOf(groupId) {
                    const rows = await db
                        .select({
                            messageId: essencesPg.messageId,
                            setBy: essencesPg.setBy,
                            setAt: essencesPg.createdAt,
                            sender: messagesPg.sender,
                            content: messagesPg.content,
                            kind: messagesPg.kind,
                            createdAt: messagesPg.createdAt,
                            recalledAt: messagesPg.recalledAt,
                        })
                        .from(essencesPg)
                        .innerJoin(
                            messagesPg,
                            eq(messagesPg.id, essencesPg.messageId),
                        )
                        .where(eq(essencesPg.groupId, groupId))
                        .orderBy(desc(essencesPg.createdAt))
                        .limit(200);
                    return rows
                        .filter((row) => row.recalledAt === null)
                        .map(
                            (row): EssenceItemRow => ({
                                messageId: row.messageId,
                                sender: row.sender,
                                content: row.content,
                                kind: row.kind,
                                createdAt: toIso(row.createdAt),
                                setBy: row.setBy,
                                setAt: toIso(row.setAt),
                            }),
                        );
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
                "link",
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
            for (const col of ["is_admin", "banned", "token_version"]) {
                if (!userColumns.some((item) => item.name === col)) {
                    client.exec(
                        `ALTER TABLE users ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`,
                    );
                }
            }
            const groupColumns = client.pragma("table_info(groups)") as Array<{
                name: string;
            }>;
            for (const [col, type] of [
                ["no_friend_add", "INTEGER NOT NULL DEFAULT 0"],
                ["invite_code", "TEXT"],
                ["invite_expires_at", "INTEGER"],
                ["join_approval", "INTEGER NOT NULL DEFAULT 1"],
            ]) {
                if (!groupColumns.some((item) => item.name === col)) {
                    client.exec(`ALTER TABLE groups ADD COLUMN ${col} ${type}`);
                }
            }
            const momentColumns = client.pragma(
                "table_info(moments)",
            ) as Array<{ name: string }>;
            if (!momentColumns.some((item) => item.name === "video"))
                client.exec("ALTER TABLE moments ADD COLUMN video TEXT");
            if (!momentColumns.some((item) => item.name === "link"))
                client.exec("ALTER TABLE moments ADD COLUMN link TEXT");
            const db = drizzleSqlite(client);

            const messageCursor = async (id: string) => {
                const rows = await db
                    .select({
                        id: messagesSqlite.id,
                        createdAt: messagesSqlite.createdAt,
                    })
                    .from(messagesSqlite)
                    .where(eq(messagesSqlite.id, id))
                    .limit(1);
                const row = rows[0];
                return row ? { id: row.id, at: row.createdAt } : null;
            };
            const olderThan = (at: number, id: string) =>
                sql`(${messagesSqlite.createdAt} < ${at} OR (${messagesSqlite.createdAt} = ${at} AND ${messagesSqlite.id} <= ${id}))`;
            const newerThan = (at: number, id: string) =>
                sql`(${messagesSqlite.createdAt} > ${at} OR (${messagesSqlite.createdAt} = ${at} AND ${messagesSqlite.id} >= ${id}))`;

            const userToRow = (
                row: typeof usersSqlite.$inferSelect,
            ): UserWithHash => ({
                id: row.id,
                username: row.username,
                passwordHash: row.passwordHash,
                createdAt: toIso(row.createdAt),
                isAdmin: row.isAdmin,
                banned: row.banned,
                tokenVersion: row.tokenVersion,
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
                noFriendAdd: row.noFriendAdd,
                inviteCode: row.inviteCode,
                inviteExpiresAt:
                    row.inviteExpiresAt === null
                        ? null
                        : toIso(row.inviteExpiresAt),
                joinApproval: row.joinApproval,
                createdAt: toIso(row.createdAt),
            });
            const pushToRow = (
                row: typeof pushSqlite.$inferSelect,
            ): PushSubscriptionRow => ({
                userId: row.userId,
                endpoint: row.endpoint,
                p256dh: row.p256dh,
                auth: row.auth,
                createdAt: toIso(row.createdAt),
            });

            store = {
                async save(input) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    const {
                        quote,
                        mentions,
                        file: meta,
                        link,
                        ...rest
                    } = input;
                    await db.insert(messagesSqlite).values({
                        id,
                        ...rest,
                        quote: serializeQuote(quote),
                        mentions: serializeMentions(mentions),
                        file: meta ? JSON.stringify(meta) : null,
                        link: link ? JSON.stringify(link) : null,
                        createdAt: now,
                    });
                    return {
                        id,
                        ...rest,
                        quote: quote ?? null,
                        mentions: mentions ?? null,
                        file: meta ?? null,
                        link: link ?? null,
                        createdAt: new Date(now).toISOString(),
                        recalledAt: null,
                    };
                },
                async list(session, limit, before, after, beforeId, afterId) {
                    const conds = [eq(messagesSqlite.session, session)];
                    const older = beforeId
                        ? await messageCursor(beforeId)
                        : null;
                    const newer = afterId ? await messageCursor(afterId) : null;
                    if (older) conds.push(olderThan(older.at, older.id));
                    else if (before)
                        conds.push(
                            lt(
                                messagesSqlite.createdAt,
                                new Date(before).getTime(),
                            ),
                        );
                    if (newer) conds.push(newerThan(newer.at, newer.id));
                    else if (after)
                        conds.push(
                            gt(
                                messagesSqlite.createdAt,
                                new Date(after).getTime(),
                            ),
                        );
                    const forward = Boolean(newer) || Boolean(!older && after);
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(and(...conds))
                        .orderBy(
                            forward
                                ? asc(messagesSqlite.createdAt)
                                : desc(messagesSqlite.createdAt),
                            forward
                                ? asc(messagesSqlite.id)
                                : desc(messagesSqlite.id),
                        )
                        .limit(limit);
                    const list = rows.map(messageRowToChat);
                    return forward ? list : list.reverse();
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
                async search(params) {
                    const conds = [isNull(messagesSqlite.recalledAt)];
                    if (params.session)
                        conds.push(eq(messagesSqlite.session, params.session));
                    if (params.sessions) {
                        if (params.sessions.length === 0)
                            return { rows: [], total: 0 };
                        conds.push(
                            inArray(messagesSqlite.session, params.sessions),
                        );
                    }
                    if (params.sender)
                        conds.push(eq(messagesSqlite.sender, params.sender));
                    if (params.media)
                        conds.push(ne(messagesSqlite.kind, "text"));
                    if (params.keyword)
                        conds.push(
                            likeKeyword(messagesSqlite.content, params.keyword),
                        );
                    const where = and(...conds);
                    const counted = await db
                        .select({ id: messagesSqlite.id })
                        .from(messagesSqlite)
                        .where(where);
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(where)
                        .orderBy(desc(messagesSqlite.createdAt))
                        .limit(params.limit)
                        .offset(params.offset);
                    return {
                        rows: rows.map(messageRowToChat),
                        total: counted.length,
                    };
                },
                async deleteOlderThan(iso) {
                    const rows = await db
                        .delete(messagesSqlite)
                        .where(
                            lt(
                                messagesSqlite.createdAt,
                                new Date(iso).getTime(),
                            ),
                        )
                        .returning();
                    return rows.map(messageRowToChat);
                },
                async countByContent(content) {
                    const rows = await db
                        .select({ id: messagesSqlite.id })
                        .from(messagesSqlite)
                        .where(eq(messagesSqlite.content, content));
                    return rows.length;
                },
                async trend(days) {
                    const count = trendDays(days);
                    const dayExpr = sql<string>`date(${messagesSqlite.createdAt} / 1000, 'unixepoch', 'localtime')`;
                    const rows = await db
                        .select({
                            date: dayExpr,
                            messages: sql<number>`count(*)`,
                            senders: sql<number>`count(distinct ${messagesSqlite.sender})`,
                        })
                        .from(messagesSqlite)
                        .where(
                            gte(
                                messagesSqlite.createdAt,
                                trendStart(count).getTime(),
                            ),
                        )
                        .groupBy(dayExpr)
                        .orderBy(dayExpr);
                    return fillTrend(rows, count);
                },
                async count() {
                    const rows = await db
                        .select({ id: messagesSqlite.id })
                        .from(messagesSqlite);
                    return rows.length;
                },
                async mediaBytes() {
                    const rows = await db
                        .select({
                            total: sql<number>`coalesce(sum(length(${messagesSqlite.content})), 0)`,
                        })
                        .from(messagesSqlite)
                        .where(ne(messagesSqlite.kind, "text"));
                    return Number(rows[0]?.total ?? 0);
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
                async setPassword(id, passwordHash) {
                    const rows = await db
                        .select({ version: usersSqlite.tokenVersion })
                        .from(usersSqlite)
                        .where(eq(usersSqlite.id, id))
                        .limit(1);
                    const version = (rows[0]?.version ?? 0) + 1;
                    await db
                        .update(usersSqlite)
                        .set({ passwordHash, tokenVersion: version })
                        .where(eq(usersSqlite.id, id));
                    return version;
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
                async setRemark(ownerId, friendId, remark) {
                    if (!remark) {
                        await db
                            .delete(friendRemarksSqlite)
                            .where(
                                and(
                                    eq(friendRemarksSqlite.ownerId, ownerId),
                                    eq(friendRemarksSqlite.friendId, friendId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(friendRemarksSqlite)
                        .values({ ownerId, friendId, remark })
                        .onConflictDoUpdate({
                            target: [
                                friendRemarksSqlite.ownerId,
                                friendRemarksSqlite.friendId,
                            ],
                            set: { remark },
                        });
                },
                async remarksOf(ownerId) {
                    const rows = await db
                        .select()
                        .from(friendRemarksSqlite)
                        .where(eq(friendRemarksSqlite.ownerId, ownerId));
                    const result: Record<string, string> = {};
                    for (const row of rows) result[row.friendId] = row.remark;
                    return result;
                },
                async groupListOf(ownerId) {
                    const rows = await db
                        .select()
                        .from(friendGroupsSqlite)
                        .where(eq(friendGroupsSqlite.ownerId, ownerId))
                        .orderBy(asc(friendGroupsSqlite.createdAt));
                    return rows.map((row) => ({
                        id: row.id,
                        ownerId: row.ownerId,
                        name: row.name,
                        createdAt: toIso(row.createdAt),
                    }));
                },
                async groupCreate(ownerId, name) {
                    const id = crypto.randomUUID();
                    const createdAt = Date.now();
                    await db.insert(friendGroupsSqlite).values({
                        id,
                        ownerId,
                        name,
                        createdAt,
                    });
                    return {
                        id,
                        ownerId,
                        name,
                        createdAt: new Date(createdAt).toISOString(),
                    };
                },
                async groupRename(ownerId, groupId, name) {
                    await db
                        .update(friendGroupsSqlite)
                        .set({ name })
                        .where(
                            and(
                                eq(friendGroupsSqlite.id, groupId),
                                eq(friendGroupsSqlite.ownerId, ownerId),
                            ),
                        );
                },
                async groupRemove(ownerId, groupId) {
                    await db
                        .delete(friendGroupsSqlite)
                        .where(
                            and(
                                eq(friendGroupsSqlite.id, groupId),
                                eq(friendGroupsSqlite.ownerId, ownerId),
                            ),
                        );
                    await db
                        .delete(friendGroupMembersSqlite)
                        .where(
                            and(
                                eq(friendGroupMembersSqlite.ownerId, ownerId),
                                eq(friendGroupMembersSqlite.groupId, groupId),
                            ),
                        );
                },
                async groupSetFriend(ownerId, friendId, groupId) {
                    if (!groupId) {
                        await db
                            .delete(friendGroupMembersSqlite)
                            .where(
                                and(
                                    eq(
                                        friendGroupMembersSqlite.ownerId,
                                        ownerId,
                                    ),
                                    eq(
                                        friendGroupMembersSqlite.friendId,
                                        friendId,
                                    ),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(friendGroupMembersSqlite)
                        .values({ ownerId, friendId, groupId })
                        .onConflictDoUpdate({
                            target: [
                                friendGroupMembersSqlite.ownerId,
                                friendGroupMembersSqlite.friendId,
                            ],
                            set: { groupId },
                        });
                },
                async friendGroupMap(ownerId) {
                    const rows = await db
                        .select()
                        .from(friendGroupMembersSqlite)
                        .where(eq(friendGroupMembersSqlite.ownerId, ownerId));
                    const result: Record<string, string> = {};
                    for (const row of rows) result[row.friendId] = row.groupId;
                    return result;
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
                        noFriendAdd: false,
                        inviteCode: null,
                        inviteExpiresAt: null,
                        joinApproval: true,
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
                async byInviteCode(code) {
                    const rows = await db
                        .select()
                        .from(groupsSqlite)
                        .where(eq(groupsSqlite.inviteCode, code))
                        .limit(1);
                    const row = rows[0];
                    return row ? groupToRow(row) : null;
                },
                async remove(id) {
                    await db
                        .delete(groupMembersSqlite)
                        .where(eq(groupMembersSqlite.groupId, id));
                    await db
                        .delete(joinRequestsSqlite)
                        .where(eq(joinRequestsSqlite.groupId, id));
                    await db
                        .delete(groupFilesSqlite)
                        .where(eq(groupFilesSqlite.groupId, id));
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
                async setNoFriendAdd(id, on) {
                    await db
                        .update(groupsSqlite)
                        .set({ noFriendAdd: on })
                        .where(eq(groupsSqlite.id, id));
                },
                async setInvite(id, code, expiresAt) {
                    await db
                        .update(groupsSqlite)
                        .set({
                            inviteCode: code,
                            inviteExpiresAt: expiresAt
                                ? new Date(expiresAt).getTime()
                                : null,
                        })
                        .where(eq(groupsSqlite.id, id));
                },
                async setJoinApproval(id, on) {
                    await db
                        .update(groupsSqlite)
                        .set({ joinApproval: on })
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
                async friendAddBlocked(aId, bId) {
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
                    const commonIds = common.map((row) => row.groupId);
                    if (commonIds.length === 0) return false;
                    const blocked = await db
                        .select({ id: groupsSqlite.id })
                        .from(groupsSqlite)
                        .where(
                            and(
                                inArray(groupsSqlite.id, commonIds),
                                eq(groupsSqlite.noFriendAdd, true),
                            ),
                        );
                    return blocked.length > 0;
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

            pushes = {
                async save(input) {
                    await db
                        .insert(pushSqlite)
                        .values({ ...input, createdAt: Date.now() })
                        .onConflictDoUpdate({
                            target: pushSqlite.endpoint,
                            set: {
                                userId: input.userId,
                                p256dh: input.p256dh,
                                auth: input.auth,
                            },
                        });
                },
                async remove(endpoint) {
                    await db
                        .delete(pushSqlite)
                        .where(eq(pushSqlite.endpoint, endpoint));
                },
                async ofUser(userId) {
                    const rows = await db
                        .select()
                        .from(pushSqlite)
                        .where(eq(pushSqlite.userId, userId));
                    return rows.map(pushToRow);
                },
                async ofUsers(userIds) {
                    if (userIds.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(pushSqlite)
                        .where(inArray(pushSqlite.userId, userIds));
                    return rows.map(pushToRow);
                },
                async ofAll() {
                    const rows = await db.select().from(pushSqlite);
                    return rows.map(pushToRow);
                },
            };

            mediaFiles = {
                async save(row) {
                    await db
                        .insert(mediaFilesSqlite)
                        .values({
                            ...row,
                            createdAt: Date.parse(row.createdAt),
                        })
                        .onConflictDoUpdate({
                            target: mediaFilesSqlite.key,
                            set: {
                                name: row.name,
                                mime: row.mime,
                                size: row.size,
                            },
                        });
                },
                async byKey(key) {
                    const rows = await db
                        .select()
                        .from(mediaFilesSqlite)
                        .where(eq(mediaFilesSqlite.key, key))
                        .limit(1);
                    return rows[0] ? mediaFileToRow(rows[0]) : null;
                },
                async list({ offset, limit }) {
                    const all = await db
                        .select({ key: mediaFilesSqlite.key })
                        .from(mediaFilesSqlite);
                    const rows = await db
                        .select()
                        .from(mediaFilesSqlite)
                        .orderBy(desc(mediaFilesSqlite.createdAt))
                        .limit(limit)
                        .offset(offset);
                    return {
                        rows: rows.map(mediaFileToRow),
                        total: all.length,
                    };
                },
                async olderThan(iso) {
                    const rows = await db
                        .select()
                        .from(mediaFilesSqlite)
                        .where(lt(mediaFilesSqlite.createdAt, Date.parse(iso)));
                    return rows.map(mediaFileToRow);
                },
                async totalBytes() {
                    const rows = await db
                        .select({
                            total: sql<number>`coalesce(sum(${mediaFilesSqlite.size}), 0)`,
                        })
                        .from(mediaFilesSqlite);
                    return Number(rows[0]?.total ?? 0);
                },
                async count() {
                    const rows = await db
                        .select({ key: mediaFilesSqlite.key })
                        .from(mediaFilesSqlite);
                    return rows.length;
                },
                async remove(key) {
                    await db
                        .delete(mediaFilesSqlite)
                        .where(eq(mediaFilesSqlite.key, key));
                },
            };

            groupFiles = {
                async save(row) {
                    await db
                        .insert(groupFilesSqlite)
                        .values({
                            ...row,
                            createdAt: Date.parse(row.createdAt),
                        })
                        .onConflictDoUpdate({
                            target: [
                                groupFilesSqlite.groupId,
                                groupFilesSqlite.key,
                            ],
                            set: {
                                name: row.name,
                                mime: row.mime,
                                size: row.size,
                            },
                        });
                },
                async byKey(groupId, key) {
                    const rows = await db
                        .select()
                        .from(groupFilesSqlite)
                        .where(
                            and(
                                eq(groupFilesSqlite.groupId, groupId),
                                eq(groupFilesSqlite.key, key),
                            ),
                        )
                        .limit(1);
                    return rows[0] ? groupFileToRow(rows[0]) : null;
                },
                async list(groupId, { offset, limit }) {
                    const all = await db
                        .select({ key: groupFilesSqlite.key })
                        .from(groupFilesSqlite)
                        .where(eq(groupFilesSqlite.groupId, groupId));
                    const rows = await db
                        .select()
                        .from(groupFilesSqlite)
                        .where(eq(groupFilesSqlite.groupId, groupId))
                        .orderBy(desc(groupFilesSqlite.createdAt))
                        .limit(limit)
                        .offset(offset);
                    return {
                        rows: rows.map(groupFileToRow),
                        total: all.length,
                    };
                },
                async countByKey(key) {
                    const rows = await db
                        .select({ key: groupFilesSqlite.key })
                        .from(groupFilesSqlite)
                        .where(eq(groupFilesSqlite.key, key));
                    return rows.length;
                },
                async remove(groupId, key) {
                    await db
                        .delete(groupFilesSqlite)
                        .where(
                            and(
                                eq(groupFilesSqlite.groupId, groupId),
                                eq(groupFilesSqlite.key, key),
                            ),
                        );
                },
            };

            joinRequests = {
                async upsert({ groupId, userId, message }) {
                    await db
                        .insert(joinRequestsSqlite)
                        .values({
                            groupId,
                            userId,
                            message,
                            createdAt: Date.now(),
                        })
                        .onConflictDoUpdate({
                            target: [
                                joinRequestsSqlite.groupId,
                                joinRequestsSqlite.userId,
                            ],
                            set: { message, createdAt: Date.now() },
                        });
                },
                async byGroup(groupId) {
                    const rows = await db
                        .select()
                        .from(joinRequestsSqlite)
                        .where(eq(joinRequestsSqlite.groupId, groupId))
                        .orderBy(joinRequestsSqlite.createdAt);
                    return rows.map(
                        (row): JoinRequestRow => ({
                            groupId: row.groupId,
                            userId: row.userId,
                            message: row.message,
                            createdAt: toIso(row.createdAt),
                        }),
                    );
                },
                async countByGroup(groupId) {
                    const rows = await db
                        .select({ userId: joinRequestsSqlite.userId })
                        .from(joinRequestsSqlite)
                        .where(eq(joinRequestsSqlite.groupId, groupId));
                    return rows.length;
                },
                async remove(groupId, userId) {
                    await db
                        .delete(joinRequestsSqlite)
                        .where(
                            and(
                                eq(joinRequestsSqlite.groupId, groupId),
                                eq(joinRequestsSqlite.userId, userId),
                            ),
                        );
                },
            };

            const momentVisibleFor = (viewerId: string, friendIds: string[]) =>
                or(
                    eq(momentsSqlite.authorId, viewerId),
                    and(
                        inArray(momentsSqlite.visibility, [
                            "public",
                            "exclude",
                        ]),
                        notExists(
                            db
                                .select()
                                .from(momentAudienceSqlite)
                                .where(
                                    and(
                                        eq(
                                            momentAudienceSqlite.postId,
                                            momentsSqlite.id,
                                        ),
                                        eq(
                                            momentAudienceSqlite.userId,
                                            viewerId,
                                        ),
                                    ),
                                ),
                        ),
                    ),
                    and(
                        eq(momentsSqlite.visibility, "partial"),
                        exists(
                            db
                                .select()
                                .from(momentAudienceSqlite)
                                .where(
                                    and(
                                        eq(
                                            momentAudienceSqlite.postId,
                                            momentsSqlite.id,
                                        ),
                                        eq(
                                            momentAudienceSqlite.userId,
                                            viewerId,
                                        ),
                                    ),
                                ),
                        ),
                    ),
                    ...(friendIds.length > 0
                        ? [
                              and(
                                  eq(momentsSqlite.visibility, "friends"),
                                  inArray(momentsSqlite.authorId, friendIds),
                              ),
                          ]
                        : []),
                );

            const withMomentAudience = async (
                rows: MomentRow[],
            ): Promise<MomentRow[]> => {
                const targets = rows.filter(
                    (row) =>
                        row.visibility === "partial" ||
                        row.visibility === "exclude",
                );
                if (targets.length === 0) return rows;
                const links = await db
                    .select()
                    .from(momentAudienceSqlite)
                    .where(
                        inArray(
                            momentAudienceSqlite.postId,
                            targets.map((row) => row.id),
                        ),
                    );
                const byPost = new Map<string, string[]>();
                for (const link of links) {
                    const list = byPost.get(link.postId) ?? [];
                    list.push(link.userId);
                    byPost.set(link.postId, list);
                }
                return rows.map((row) => ({
                    ...row,
                    audience: byPost.get(row.id) ?? [],
                }));
            };

            moments = {
                async create(input) {
                    const id = crypto.randomUUID();
                    const createdAt = Date.now();
                    await db.insert(momentsSqlite).values({
                        id,
                        authorId: input.authorId,
                        content: input.content,
                        images: JSON.stringify(input.images),
                        video: input.video,
                        link: input.link ? JSON.stringify(input.link) : null,
                        visibility: input.visibility,
                        createdAt,
                    });
                    if (input.audience.length > 0)
                        await db
                            .insert(momentAudienceSqlite)
                            .values(
                                input.audience.map((userId) => ({
                                    postId: id,
                                    userId,
                                })),
                            )
                            .onConflictDoNothing();
                    return {
                        id,
                        authorId: input.authorId,
                        content: input.content,
                        images: input.images,
                        video: input.video,
                        link: input.link,
                        visibility: input.visibility,
                        audience: input.audience,
                        createdAt: new Date(createdAt).toISOString(),
                    };
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(momentsSqlite)
                        .where(eq(momentsSqlite.id, id))
                        .limit(1);
                    if (!rows[0]) return null;
                    const [row] = await withMomentAudience([
                        momentToRow(rows[0]),
                    ]);
                    return row;
                },
                async remove(id) {
                    await db
                        .delete(momentAudienceSqlite)
                        .where(eq(momentAudienceSqlite.postId, id));
                    await db
                        .delete(momentLikesSqlite)
                        .where(eq(momentLikesSqlite.postId, id));
                    await db
                        .delete(momentCommentsSqlite)
                        .where(eq(momentCommentsSqlite.postId, id));
                    await db
                        .delete(momentsSqlite)
                        .where(eq(momentsSqlite.id, id));
                },
                async list({
                    viewerId,
                    friendIds,
                    author,
                    before,
                    beforeId,
                    limit,
                }) {
                    const at = before ? new Date(before).getTime() : null;
                    const rows = await db
                        .select()
                        .from(momentsSqlite)
                        .where(
                            and(
                                momentVisibleFor(viewerId, friendIds),
                                author
                                    ? eq(momentsSqlite.authorId, author)
                                    : undefined,
                                at === null
                                    ? undefined
                                    : beforeId
                                      ? sql`(${momentsSqlite.createdAt} < ${at} OR (${momentsSqlite.createdAt} = ${at} AND ${momentsSqlite.id} < ${beforeId}))`
                                      : lt(momentsSqlite.createdAt, at),
                            ),
                        )
                        .orderBy(
                            desc(momentsSqlite.createdAt),
                            desc(momentsSqlite.id),
                        )
                        .limit(limit);
                    return withMomentAudience(rows.map(momentToRow));
                },
                async audienceOf(postId) {
                    const rows = await db
                        .select()
                        .from(momentAudienceSqlite)
                        .where(eq(momentAudienceSqlite.postId, postId));
                    return rows.map((row) => row.userId);
                },
                async unread(userId, friendIds) {
                    const seenRows = await db
                        .select()
                        .from(momentReadsSqlite)
                        .where(eq(momentReadsSqlite.userId, userId))
                        .limit(1);
                    const seen = seenRows[0]?.seenAt ?? 0;
                    const postRows = await db
                        .select({ n: sql<number>`count(*)` })
                        .from(momentsSqlite)
                        .where(
                            and(
                                gt(momentsSqlite.createdAt, seen),
                                ne(momentsSqlite.authorId, userId),
                                friendIds.length > 0
                                    ? inArray(momentsSqlite.authorId, friendIds)
                                    : sql`1 = 0`,
                                momentVisibleFor(userId, friendIds),
                            ),
                        );
                    const likeRows = await db
                        .select({ n: sql<number>`count(*)` })
                        .from(momentLikesSqlite)
                        .innerJoin(
                            momentsSqlite,
                            eq(momentLikesSqlite.postId, momentsSqlite.id),
                        )
                        .where(
                            and(
                                eq(momentsSqlite.authorId, userId),
                                ne(momentLikesSqlite.userId, userId),
                                gt(momentLikesSqlite.at, seen),
                            ),
                        );
                    const commentRows = await db
                        .select({ n: sql<number>`count(*)` })
                        .from(momentCommentsSqlite)
                        .innerJoin(
                            momentsSqlite,
                            eq(momentCommentsSqlite.postId, momentsSqlite.id),
                        )
                        .where(
                            and(
                                eq(momentsSqlite.authorId, userId),
                                ne(momentCommentsSqlite.authorId, userId),
                                gt(momentCommentsSqlite.createdAt, seen),
                            ),
                        );
                    return {
                        posts: Number(postRows[0]?.n ?? 0),
                        interactions:
                            Number(likeRows[0]?.n ?? 0) +
                            Number(commentRows[0]?.n ?? 0),
                    };
                },
                async markSeen(userId, at) {
                    const seenAt = new Date(at).getTime();
                    await db
                        .insert(momentReadsSqlite)
                        .values({ userId, seenAt })
                        .onConflictDoUpdate({
                            target: momentReadsSqlite.userId,
                            set: { seenAt },
                        });
                },
                async setLike(postId, userId, liked) {
                    if (!liked) {
                        await db
                            .delete(momentLikesSqlite)
                            .where(
                                and(
                                    eq(momentLikesSqlite.postId, postId),
                                    eq(momentLikesSqlite.userId, userId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(momentLikesSqlite)
                        .values({ postId, userId, at: Date.now() })
                        .onConflictDoNothing();
                },
                async likesOf(postIds) {
                    if (postIds.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(momentLikesSqlite)
                        .where(inArray(momentLikesSqlite.postId, postIds))
                        .orderBy(asc(momentLikesSqlite.at));
                    return rows.map(momentLikeToRow);
                },
                async addComment(input) {
                    const id = crypto.randomUUID();
                    const createdAt = Date.now();
                    await db.insert(momentCommentsSqlite).values({
                        id,
                        postId: input.postId,
                        authorId: input.authorId,
                        content: input.content,
                        createdAt,
                    });
                    return {
                        id,
                        postId: input.postId,
                        authorId: input.authorId,
                        content: input.content,
                        createdAt: new Date(createdAt).toISOString(),
                    };
                },
                async commentsOf(postIds) {
                    if (postIds.length === 0) return [];
                    const rows = await db
                        .select()
                        .from(momentCommentsSqlite)
                        .where(inArray(momentCommentsSqlite.postId, postIds))
                        .orderBy(asc(momentCommentsSqlite.createdAt));
                    return rows.map(momentCommentToRow);
                },
            };

            essences = {
                async add(groupId, messageId, setBy) {
                    await db
                        .insert(essencesSqlite)
                        .values({
                            groupId,
                            messageId,
                            setBy,
                            createdAt: Date.now(),
                        })
                        .onConflictDoNothing();
                },
                async remove(groupId, messageId) {
                    await db
                        .delete(essencesSqlite)
                        .where(
                            and(
                                eq(essencesSqlite.groupId, groupId),
                                eq(essencesSqlite.messageId, messageId),
                            ),
                        );
                },
                async has(groupId, messageId) {
                    const rows = await db
                        .select({ messageId: essencesSqlite.messageId })
                        .from(essencesSqlite)
                        .where(
                            and(
                                eq(essencesSqlite.groupId, groupId),
                                eq(essencesSqlite.messageId, messageId),
                            ),
                        )
                        .limit(1);
                    return rows.length > 0;
                },
                async listOf(groupId) {
                    const rows = await db
                        .select({
                            messageId: essencesSqlite.messageId,
                            setBy: essencesSqlite.setBy,
                            setAt: essencesSqlite.createdAt,
                            sender: messagesSqlite.sender,
                            content: messagesSqlite.content,
                            kind: messagesSqlite.kind,
                            createdAt: messagesSqlite.createdAt,
                            recalledAt: messagesSqlite.recalledAt,
                        })
                        .from(essencesSqlite)
                        .innerJoin(
                            messagesSqlite,
                            eq(messagesSqlite.id, essencesSqlite.messageId),
                        )
                        .where(eq(essencesSqlite.groupId, groupId))
                        .orderBy(desc(essencesSqlite.createdAt))
                        .limit(200);
                    return rows
                        .filter((row) => row.recalledAt === null)
                        .map(
                            (row): EssenceItemRow => ({
                                messageId: row.messageId,
                                sender: row.sender,
                                content: row.content,
                                kind: row.kind,
                                createdAt: toIso(row.createdAt),
                                setBy: row.setBy,
                                setAt: toIso(row.setAt),
                            }),
                        );
                },
            };

            ctx.log.info(`storage driver: sqlite (${file})`);
        }

        ctx.provide<MessageStore>("store", store);
        ctx.provide<AccountsStore>("accounts", accounts);
        ctx.provide<FriendsStore>("friendships", friends);
        ctx.provide<GroupsStore>("groups", groups);
        ctx.provide<EssencesStore>("essences", essences);
        ctx.provide<ReadsStore>("reads", reads);
        ctx.provide<SettingsStore>("settings", settings);
        ctx.provide<PushStore>("pushes", pushes);
        ctx.provide<MediaFilesStore>("mediaFiles", mediaFiles);
        ctx.provide<GroupFilesStore>("groupFiles", groupFiles);
        ctx.provide<JoinRequestsStore>("join-requests", joinRequests);
        ctx.provide<MomentsStore>("moments", moments);
        return undefined;
    },
};
