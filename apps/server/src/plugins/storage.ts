import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@plugim/core";
import type {
    AABillInfo,
    BotScope,
    ChatMessage,
    FileMeta,
    GroupRole,
    LinkPreview,
    MessageQuote,
    MessageReactions,
    MomentVisibility,
    RedPacketInfo,
    TransferInfo,
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
    lte,
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
    AABillRow,
    AAPaymentRow,
    AAPayResult,
    AccountsStore,
    AdminUserRow,
    AuditRow,
    AuditStore,
    AuthDeviceRow,
    AuthSessionsStore,
    BotAppRow,
    BotHookRow,
    BotsStore,
    DepartmentRow,
    DepartmentsStore,
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
    RedPacketClaimResult,
    RedPacketRow,
    RedPacketStore,
    SessionMetaStore,
    SettingsStore,
    TransferCreateResult,
    TransferRow,
    TransferSettleResult,
    TransferState,
    UserWithHash,
    WalletStore,
} from "../types";
import type { AppConfig } from "./config";

const messagesSqlite = sqliteTable("messages", {
    id: sqliteText("id").primaryKey(),
    session: sqliteText("session").notNull(),
    sender: sqliteText("sender").notNull(),
    content: sqliteText("content").notNull(),
    seq: integer("seq").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    recalledAt: integer("recalled_at"),
    editedAt: integer("edited_at"),
    editCount: integer("edit_count").notNull().default(0),
    quote: sqliteText("quote"),
    mentions: sqliteText("mentions"),
    kind: sqliteText("kind"),
    file: sqliteText("file"),
    link: sqliteText("link"),
    reactions: sqliteText("reactions"),
    redPacket: sqliteText("red_packet"),
    transfer: sqliteText("transfer"),
    aaBill: sqliteText("aa_bill"),
});

const messagesPg = pgTable("messages", {
    id: pgText("id").primaryKey(),
    session: pgText("session").notNull(),
    sender: pgText("sender").notNull(),
    content: pgText("content").notNull(),
    seq: pgInteger("seq").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    recalledAt: timestamp("recalled_at", { withTimezone: true }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    editCount: pgInteger("edit_count").notNull().default(0),
    quote: pgText("quote"),
    mentions: pgText("mentions"),
    kind: pgText("kind"),
    file: pgText("file"),
    link: pgText("link"),
    reactions: pgText("reactions"),
    redPacket: pgText("red_packet"),
    transfer: pgText("transfer"),
    aaBill: pgText("aa_bill"),
});

const redPacketsSqlite = sqliteTable("red_packets", {
    id: sqliteText("id").primaryKey(),
    sessionId: sqliteText("session_id").notNull(),
    senderId: sqliteText("sender_id").notNull(),
    type: sqliteText("type").notNull(),
    totalAmount: integer("total_amount").notNull(),
    totalCount: integer("total_count").notNull(),
    remaining: integer("remaining").notNull(),
    remainCount: integer("remain_count").notNull(),
    status: sqliteText("status").notNull(),
    message: sqliteText("message"),
    createdAt: integer("created_at").notNull(),
    expiredAt: integer("expired_at"),
});

const redPacketsPg = pgTable("red_packets", {
    id: pgText("id").primaryKey(),
    sessionId: pgText("session_id").notNull(),
    senderId: pgText("sender_id").notNull(),
    type: pgText("type").notNull(),
    totalAmount: pgInteger("total_amount").notNull(),
    totalCount: pgInteger("total_count").notNull(),
    remaining: pgInteger("remaining").notNull(),
    remainCount: pgInteger("remain_count").notNull(),
    status: pgText("status").notNull(),
    message: pgText("message"),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
});

const redPacketRecordsSqlite = sqliteTable(
    "red_packet_records",
    {
        id: sqliteText("id").primaryKey(),
        redPacketId: sqliteText("red_packet_id").notNull(),
        claimerId: sqliteText("claimer_id").notNull(),
        amount: integer("amount").notNull(),
        claimedAt: integer("claimed_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.redPacketId, table.claimerId] })],
);

const redPacketRecordsPg = pgTable(
    "red_packet_records",
    {
        id: pgText("id").primaryKey(),
        redPacketId: pgText("red_packet_id").notNull(),
        claimerId: pgText("claimer_id").notNull(),
        amount: pgInteger("amount").notNull(),
        claimedAt: timestamp("claimed_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [
        pgPrimaryKey({ columns: [table.redPacketId, table.claimerId] }),
    ],
);

const usersSqlite = sqliteTable("users", {
    id: sqliteText("id").primaryKey(),
    username: sqliteText("username").notNull().unique(),
    passwordHash: sqliteText("password_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
    banned: integer("banned", { mode: "boolean" }).notNull().default(false),
    tokenVersion: integer("token_version").notNull().default(0),
    deptId: sqliteText("dept_id"),
    title: sqliteText("title"),
    balance: integer("balance").notNull().default(0),
    mustChangePassword: integer("must_change_password", { mode: "boolean" })
        .notNull()
        .default(false),
    totpSecret: sqliteText("totp_secret"),
});

const transfersSqlite = sqliteTable("transfers", {
    id: sqliteText("id").primaryKey(),
    session: sqliteText("session").notNull(),
    fromId: sqliteText("from_id").notNull(),
    toId: sqliteText("to_id").notNull(),
    amount: integer("amount").notNull(),
    message: sqliteText("message"),
    state: sqliteText("state").notNull(),
    createdAt: integer("created_at").notNull(),
    expiredAt: integer("expired_at").notNull(),
});

const transfersPg = pgTable("transfers", {
    id: pgText("id").primaryKey(),
    session: pgText("session").notNull(),
    fromId: pgText("from_id").notNull(),
    toId: pgText("to_id").notNull(),
    amount: pgInteger("amount").notNull(),
    message: pgText("message"),
    state: pgText("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    expiredAt: timestamp("expired_at", { withTimezone: true }).notNull(),
});

const aaBillsSqlite = sqliteTable("aa_bills", {
    id: sqliteText("id").primaryKey(),
    session: sqliteText("session").notNull(),
    creatorId: sqliteText("creator_id").notNull(),
    description: sqliteText("description").notNull(),
    totalAmount: integer("total_amount").notNull(),
    settledAmount: integer("settled_amount").notNull().default(0),
    participantIds: sqliteText("participant_ids").notNull(),
    splitType: sqliteText("split_type").notNull(),
    customSplits: sqliteText("custom_splits"),
    status: sqliteText("status").notNull(),
    createdAt: integer("created_at").notNull(),
    deadline: integer("deadline").notNull(),
});

const aaBillsPg = pgTable("aa_bills", {
    id: pgText("id").primaryKey(),
    session: pgText("session").notNull(),
    creatorId: pgText("creator_id").notNull(),
    description: pgText("description").notNull(),
    totalAmount: pgInteger("total_amount").notNull(),
    settledAmount: pgInteger("settled_amount").notNull().default(0),
    participantIds: pgText("participant_ids").notNull(),
    splitType: pgText("split_type").notNull(),
    customSplits: pgText("custom_splits"),
    status: pgText("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    deadline: timestamp("deadline", { withTimezone: true }).notNull(),
});

const aaPaymentsSqlite = sqliteTable(
    "aa_payments",
    {
        id: sqliteText("id").primaryKey(),
        billId: sqliteText("bill_id").notNull(),
        payerId: sqliteText("payer_id").notNull(),
        amount: integer("amount").notNull(),
        paidAt: integer("paid_at").notNull(),
    },
    (table) => [primaryKey({ columns: [table.billId, table.payerId] })],
);

const aaPaymentsPg = pgTable(
    "aa_payments",
    {
        id: pgText("id").primaryKey(),
        billId: pgText("bill_id").notNull(),
        payerId: pgText("payer_id").notNull(),
        amount: pgInteger("amount").notNull(),
        paidAt: timestamp("paid_at", { withTimezone: true })
            .notNull()
            .defaultNow(),
    },
    (table) => [pgPrimaryKey({ columns: [table.billId, table.payerId] })],
);

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
    deptId: pgText("dept_id"),
    title: pgText("title"),
    balance: pgInteger("balance").notNull().default(0),
    mustChangePassword: pgBoolean("must_change_password")
        .notNull()
        .default(false),
    totpSecret: pgText("totp_secret"),
});

const departmentsSqlite = sqliteTable("departments", {
    id: sqliteText("id").primaryKey(),
    name: sqliteText("name").notNull(),
    parentId: sqliteText("parent_id"),
    sort: integer("sort").notNull().default(0),
    groupId: sqliteText("group_id"),
    createdAt: integer("created_at").notNull(),
});

const departmentsPg = pgTable("departments", {
    id: pgText("id").primaryKey(),
    name: pgText("name").notNull(),
    parentId: pgText("parent_id"),
    sort: pgInteger("sort").notNull().default(0),
    groupId: pgText("group_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
});

const auditsSqlite = sqliteTable("audit_logs", {
    id: sqliteText("id").primaryKey(),
    actorId: sqliteText("actor_id"),
    actor: sqliteText("actor").notNull(),
    action: sqliteText("action").notNull(),
    detail: sqliteText("detail").notNull().default(""),
    createdAt: integer("created_at").notNull(),
});

const auditsPg = pgTable("audit_logs", {
    id: pgText("id").primaryKey(),
    actorId: pgText("actor_id"),
    actor: pgText("actor").notNull(),
    action: pgText("action").notNull(),
    detail: pgText("detail").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
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
        title: sqliteText("title"),
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
        title: pgText("title"),
    },
    (table) => [pgPrimaryKey({ columns: [table.groupId, table.userId] })],
);

const readsSqlite = sqliteTable(
    "reads",
    {
        userId: sqliteText("user_id").notNull(),
        session: sqliteText("session").notNull(),
        readAt: integer("read_at").notNull(),
        seq: integer("seq").notNull().default(0),
    },
    (table) => [primaryKey({ columns: [table.userId, table.session] })],
);

const readsPg = pgTable(
    "reads",
    {
        userId: pgText("user_id").notNull(),
        session: pgText("session").notNull(),
        readAt: timestamp("read_at", { withTimezone: true }).notNull(),
        seq: pgInteger("seq").notNull().default(0),
    },
    (table) => [pgPrimaryKey({ columns: [table.userId, table.session] })],
);

const sessionMetaSqlite = sqliteTable(
    "session_meta",
    {
        userId: sqliteText("user_id").notNull(),
        session: sqliteText("session").notNull(),
        pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    },
    (table) => [primaryKey({ columns: [table.userId, table.session] })],
);

const sessionMetaPg = pgTable(
    "session_meta",
    {
        userId: pgText("user_id").notNull(),
        session: pgText("session").notNull(),
        pinned: pgBoolean("pinned").notNull().default(false),
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
        message: sqliteText("message"),
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
        message: pgText("message"),
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

const friendStarsSqlite = sqliteTable(
    "friend_stars",
    {
        ownerId: sqliteText("owner_id").notNull(),
        friendId: sqliteText("friend_id").notNull(),
    },
    (table) => [primaryKey({ columns: [table.ownerId, table.friendId] })],
);

const friendStarsPg = pgTable(
    "friend_stars",
    {
        ownerId: pgText("owner_id").notNull(),
        friendId: pgText("friend_id").notNull(),
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

const authSessionsSqlite = sqliteTable("auth_sessions", {
    id: sqliteText("id").primaryKey(),
    userId: sqliteText("user_id").notNull(),
    label: sqliteText("label").notNull().default(""),
    userAgent: sqliteText("user_agent").notNull().default(""),
    ip: sqliteText("ip").notNull().default(""),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    revokedAt: integer("revoked_at"),
});

const botAppsSqlite = sqliteTable("bot_apps", {
    id: sqliteText("id").primaryKey(),
    ownerId: sqliteText("owner_id").notNull(),
    name: sqliteText("name").notNull(),
    tokenHash: sqliteText("token_hash").notNull(),
    scopes: sqliteText("scopes").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
});

const botHooksSqlite = sqliteTable("bot_hooks", {
    id: sqliteText("id").primaryKey(),
    botId: sqliteText("bot_id").notNull(),
    url: sqliteText("url").notNull(),
    secret: sqliteText("secret").notNull(),
    events: sqliteText("events").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    failures: integer("failures").notNull().default(0),
    lastError: sqliteText("last_error"),
    createdAt: integer("created_at").notNull(),
});

const authSessionsPg = pgTable("auth_sessions", {
    id: pgText("id").primaryKey(),
    userId: pgText("user_id").notNull(),
    label: pgText("label").notNull().default(""),
    userAgent: pgText("user_agent").notNull().default(""),
    ip: pgText("ip").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

const botAppsPg = pgTable("bot_apps", {
    id: pgText("id").primaryKey(),
    ownerId: pgText("owner_id").notNull(),
    name: pgText("name").notNull(),
    tokenHash: pgText("token_hash").notNull(),
    scopes: pgText("scopes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    lastUsedAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

const botHooksPg = pgTable("bot_hooks", {
    id: pgText("id").primaryKey(),
    botId: pgText("bot_id").notNull(),
    url: pgText("url").notNull(),
    secret: pgText("secret").notNull(),
    events: pgText("events").notNull(),
    enabled: pgBoolean("enabled").notNull().default(true),
    failures: pgInteger("failures").notNull().default(0),
    lastError: pgText("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
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
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  recalled_at INTEGER,
  edited_at INTEGER,
  edit_count INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS red_packets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  remain_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at INTEGER NOT NULL,
  expired_at INTEGER
);
CREATE INDEX IF NOT EXISTS red_packets_session_idx ON red_packets (session_id, created_at);
CREATE TABLE IF NOT EXISTS red_packet_records (
  id TEXT NOT NULL,
  red_packet_id TEXT NOT NULL,
  claimer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (red_packet_id, claimer_id)
);
CREATE INDEX IF NOT EXISTS red_packet_records_idx ON red_packet_records (red_packet_id);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_session_idx ON transfers (session, created_at);
CREATE INDEX IF NOT EXISTS transfers_to_idx ON transfers (to_id, state);
CREATE TABLE IF NOT EXISTS aa_bills (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  description TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  settled_amount INTEGER NOT NULL DEFAULT 0,
  participant_ids TEXT NOT NULL,
  split_type TEXT NOT NULL,
  custom_splits TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deadline INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS aa_bills_session_idx ON aa_bills (session, created_at);
CREATE TABLE IF NOT EXISTS aa_payments (
  id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  paid_at INTEGER NOT NULL,
  PRIMARY KEY (bill_id, payer_id)
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  dept_id TEXT,
  title TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  group_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS friend_remarks (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_stars (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
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
  title TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS session_meta (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
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
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, last_seen_at);
CREATE TABLE IF NOT EXISTS bot_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS bot_apps_owner_idx ON bot_apps (owner_id);
CREATE TABLE IF NOT EXISTS bot_hooks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_hooks_bot_idx ON bot_hooks (bot_id, enabled)`;

const CREATE_PG = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recalled_at TIMESTAMPTZ,
  edited_at TIMESTAMPTZ,
  edit_count INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS red_packets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  type TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  remaining INTEGER NOT NULL,
  remain_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expired_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS red_packets_session_idx ON red_packets (session_id, created_at);
CREATE TABLE IF NOT EXISTS red_packet_records (
  id TEXT NOT NULL,
  red_packet_id TEXT NOT NULL,
  claimer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (red_packet_id, claimer_id)
);
CREATE INDEX IF NOT EXISTS red_packet_records_idx ON red_packet_records (red_packet_id);
CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expired_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS transfers_session_idx ON transfers (session, created_at);
CREATE INDEX IF NOT EXISTS transfers_to_idx ON transfers (to_id, state);
CREATE TABLE IF NOT EXISTS aa_bills (
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  description TEXT NOT NULL,
  total_amount INTEGER NOT NULL,
  settled_amount INTEGER NOT NULL DEFAULT 0,
  participant_ids TEXT NOT NULL,
  split_type TEXT NOT NULL,
  custom_splits TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS aa_bills_session_idx ON aa_bills (session, created_at);
CREATE TABLE IF NOT EXISTS aa_payments (
  id TEXT NOT NULL,
  bill_id TEXT NOT NULL,
  payer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_id, payer_id)
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session, created_at);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  banned BOOLEAN NOT NULL DEFAULT FALSE,
  token_version INTEGER NOT NULL DEFAULT 0,
  dept_id TEXT,
  title TEXT,
  balance INTEGER NOT NULL DEFAULT 0,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret TEXT
);
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  group_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at);
CREATE TABLE IF NOT EXISTS friendships (
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE TABLE IF NOT EXISTS friend_remarks (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT NOT NULL,
  PRIMARY KEY (owner_id, friend_id)
);
CREATE TABLE IF NOT EXISTS friend_stars (
  owner_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
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
  title TEXT,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, session)
);
CREATE TABLE IF NOT EXISTS session_meta (
  user_id TEXT NOT NULL,
  session TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
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
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, last_seen_at);
CREATE TABLE IF NOT EXISTS bot_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bot_apps_owner_idx ON bot_apps (owner_id);
CREATE TABLE IF NOT EXISTS bot_hooks (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_hooks_bot_idx ON bot_hooks (bot_id, enabled)`;

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

const serializeReactions = (
    reactions?: MessageReactions | null,
): string | null => {
    if (!reactions) return null;
    const entries = Object.entries(reactions).filter(
        ([emoji, users]) =>
            emoji.length > 0 &&
            Array.isArray(users) &&
            users.length > 0 &&
            users.every((user) => typeof user === "string"),
    );
    if (entries.length === 0) return null;
    return JSON.stringify(Object.fromEntries(entries));
};

const parseReactions = (raw: unknown): MessageReactions | null => {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return null;
        const out: MessageReactions = {};
        for (const [emoji, users] of Object.entries(parsed)) {
            if (!Array.isArray(users) || emoji.length === 0) continue;
            const list = users.filter(
                (item): item is string => typeof item === "string",
            );
            if (list.length > 0) out[emoji] = list;
        }
        return Object.keys(out).length > 0 ? out : null;
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
    seq: number;
    createdAt: Date | number;
    recalledAt: Date | number | null;
    quote: string | null;
    mentions: string | null;
    kind: string | null;
    file: string | null;
    link: string | null;
    reactions: string | null;
    redPacket: string | null;
    transfer: string | null;
    aaBill: string | null;
    editedAt: Date | number | null;
    editCount: number;
}

const parseJsonField = <T>(
    raw: unknown,
    guard: (v: T) => boolean,
): T | null => {
    if (typeof raw !== "string" || !raw) return null;
    try {
        const parsed = JSON.parse(raw) as T;
        return guard(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

const parseRedPacket = (raw: unknown): RedPacketInfo | null =>
    parseJsonField<RedPacketInfo>(
        raw,
        (v) => typeof v.id === "string" && typeof v.senderId === "string",
    );

const parseTransfer = (raw: unknown): TransferInfo | null =>
    parseJsonField<TransferInfo>(
        raw,
        (v) => typeof v.id === "string" && typeof v.fromId === "string",
    );

const parseAABill = (raw: unknown): AABillInfo | null =>
    parseJsonField<AABillInfo>(
        raw,
        (v) => typeof v.id === "string" && typeof v.creatorId === "string",
    );

const parseIdList = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string")
            : [];
    } catch {
        return [];
    }
};

const parseSplitMap = (raw: string | null): Record<string, number> => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter(([, v]) => typeof v === "number")
                .map(([k, v]) => [k, v as number]),
        );
    } catch {
        return {};
    }
};

const EMPTY_CLAIM_BACK = {
    status: "expired" as const,
    remaining: 0,
    remainCount: 0,
    claimedCount: 0,
};

const splitOf = (bill: AABillRow, userId: string): number | null => {
    if (!bill.participantIds.includes(userId)) return null;
    if (bill.splitType === "custom") return bill.customSplits[userId] ?? null;
    return Math.floor(bill.totalAmount / bill.participantIds.length);
};

const messageRowToChat = (row: MessageDbRow) => ({
    id: row.id,
    session: row.session,
    sender: row.sender,
    content: row.content,
    seq: row.seq,
    createdAt: toIso(row.createdAt),
    recalledAt: row.recalledAt === null ? null : toIso(row.recalledAt),
    editedAt: row.editedAt === null ? null : toIso(row.editedAt),
    editCount: row.editCount ?? 0,
    quote: parseQuote(row.quote),
    mentions: parseMentions(row.mentions),
    kind: (row.kind ?? "text") as "text",
    file: parseFile(row.file),
    link: parseLink(row.link),
    reactions: parseReactions(row.reactions),
    redPacket: parseRedPacket(row.redPacket),
    transfer: parseTransfer(row.transfer),
    aaBill: parseAABill(row.aaBill),
});

const authDeviceOf = (row: {
    id: string;
    label: string;
    userAgent: string;
    ip: string;
    createdAt: Date | number;
    lastSeenAt: Date | number;
    revokedAt: Date | number | null;
}): AuthDeviceRow => ({
    id: row.id,
    label: row.label,
    userAgent: row.userAgent,
    ip: row.ip,
    createdAt: toIso(row.createdAt),
    lastSeenAt: toIso(row.lastSeenAt),
    revoked: row.revokedAt !== null,
});

const parseScopeList = (raw: string): BotScope[] => {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed))
            return parsed.filter(
                (item): item is BotScope =>
                    item === "messages:read" ||
                    item === "messages:write" ||
                    item === "events",
            );
    } catch {}
    return [];
};

const serializeScopes = (scopes: BotScope[]): string =>
    JSON.stringify([...new Set(scopes)]);

const botAppOf = (
    row: {
        id: string;
        ownerId: string;
        name: string;
        tokenHash: string;
        scopes: string;
        createdAt: Date | number;
        lastUsedAt: Date | number | null;
        revokedAt: Date | number | null;
    },
    owner: string,
): BotAppRow => ({
    id: row.id,
    ownerId: row.ownerId,
    owner,
    name: row.name,
    tokenHash: row.tokenHash,
    scopes: parseScopeList(row.scopes),
    createdAt: toIso(row.createdAt),
    lastUsedAt: row.lastUsedAt === null ? null : toIso(row.lastUsedAt),
    revoked: row.revokedAt !== null,
});

const botHookOf = (
    row: {
        id: string;
        botId: string;
        url: string;
        secret: string;
        events: string;
        enabled: boolean;
        failures: number;
        lastError: string | null;
        createdAt: Date | number;
    },
    botName: string,
): BotHookRow => ({
    id: row.id,
    botId: row.botId,
    botName,
    url: row.url,
    secret: row.secret,
    events: parseIdList(row.events),
    enabled: row.enabled,
    failures: row.failures,
    lastError: row.lastError ?? null,
    createdAt: toIso(row.createdAt),
});

const pgPacketToRow = (
    row: typeof redPacketsPg.$inferSelect,
): RedPacketRow => ({
    id: row.id,
    sessionId: row.sessionId,
    senderId: row.senderId,
    type: row.type as RedPacketRow["type"],
    totalAmount: row.totalAmount,
    totalCount: row.totalCount,
    remaining: row.remaining,
    remainCount: row.remainCount,
    status: row.status as RedPacketRow["status"],
    message: row.message,
    createdAt: row.createdAt.toISOString(),
    expiredAt: row.expiredAt ? row.expiredAt.toISOString() : null,
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
        "sessionMeta",
        "settings",
        "pushes",
        "mediaFiles",
        "groupFiles",
        "join-requests",
        "moments",
        "departments",
        "audits",
        "redPackets",
        "wallet",
        "authSessions",
        "bots",
    ],
    inject: ["config"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        let store: MessageStore;
        let accounts: AccountsStore;
        let friends: FriendsStore;
        let groups: GroupsStore;
        let reads: ReadsStore;
        let sessionMeta: SessionMetaStore;
        let settings: SettingsStore;
        let pushes: PushStore;
        let mediaFiles: MediaFilesStore;
        let groupFiles: GroupFilesStore;
        let joinRequests: JoinRequestsStore;
        let moments: MomentsStore;
        let essences: EssencesStore;
        let departments: DepartmentsStore;
        let audits: AuditStore;
        let redPackets: RedPacketStore;
        let wallet: WalletStore;
        let authSessions: AuthSessionsStore;
        let bots: BotsStore;

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
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS dept_id TEXT",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0",
            );
            await client.unsafe(
                "ALTER TABLE moments ADD COLUMN IF NOT EXISTS video TEXT",
            );
            await client.unsafe(
                "ALTER TABLE moments ADD COLUMN IF NOT EXISTS link TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS red_packet TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS transfer TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS aa_bill TEXT",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq INTEGER NOT NULL DEFAULT 0",
            );
            await client.unsafe(
                "ALTER TABLE reads ADD COLUMN IF NOT EXISTS seq INTEGER NOT NULL DEFAULT 0",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ",
            );
            await client.unsafe(
                "ALTER TABLE messages ADD COLUMN IF NOT EXISTS edit_count INTEGER NOT NULL DEFAULT 0",
            );
            await client.unsafe(
                "ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT",
            );
            await client.unsafe(
                "CREATE INDEX IF NOT EXISTS messages_session_seq_idx ON messages (session, seq)",
            );
            await client.unsafe(
                `UPDATE messages SET seq = sub.rn FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY session ORDER BY created_at, id
                    ) AS rn
                    FROM messages
                    WHERE seq = 0
                ) sub WHERE messages.id = sub.id`,
            );
            await client.unsafe(
                "ALTER TABLE group_members ADD COLUMN IF NOT EXISTS title TEXT",
            );
            await client.unsafe(
                "ALTER TABLE friendships ADD COLUMN IF NOT EXISTS message TEXT",
            );
            const db = drizzlePg(client);

            const messageCursor = async (id: string) => {
                const rows = await db
                    .select({
                        id: messagesPg.id,
                        seq: messagesPg.seq,
                        createdAt: messagesPg.createdAt,
                    })
                    .from(messagesPg)
                    .where(eq(messagesPg.id, id))
                    .limit(1);
                const row = rows[0];
                return row
                    ? { id: row.id, seq: row.seq, at: row.createdAt }
                    : null;
            };

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
                deptId: row.deptId,
                title: row.title,
                mustChangePassword: row.mustChangePassword,
            });
            const edgeToRow = (row: {
                requesterId: string;
                addresseeId: string;
                status: string;
                createdAt: Date;
                message: string | null;
            }): FriendEdge => ({
                requesterId: row.requesterId,
                addresseeId: row.addresseeId,
                status: row.status as FriendEdge["status"],
                createdAt: toIso(row.createdAt),
                message: row.message ?? null,
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
                    const {
                        quote,
                        mentions,
                        file,
                        link,
                        redPacket,
                        transfer,
                        aaBill,
                        ...rest
                    } = input;
                    const rows = await db.transaction(async (tx) => {
                        const head = await tx
                            .select({
                                max: sql<number>`coalesce(max(${messagesPg.seq}), 0)`,
                            })
                            .from(messagesPg)
                            .where(eq(messagesPg.session, rest.session));
                        const seq = Number(head[0]?.max ?? 0) + 1;
                        return tx
                            .insert(messagesPg)
                            .values({
                                id,
                                ...rest,
                                seq,
                                quote: serializeQuote(quote),
                                mentions: serializeMentions(mentions),
                                file: file ? JSON.stringify(file) : null,
                                link: link ? JSON.stringify(link) : null,
                                redPacket: redPacket
                                    ? JSON.stringify(redPacket)
                                    : null,
                                transfer: transfer
                                    ? JSON.stringify(transfer)
                                    : null,
                                aaBill: aaBill ? JSON.stringify(aaBill) : null,
                            })
                            .returning();
                    });
                    return messageRowToChat(rows[0]);
                },
                async list(session, limit, cursor) {
                    const conds = [eq(messagesPg.session, session)];
                    const forward = cursor?.afterSeq !== undefined;
                    const older = cursor?.beforeId
                        ? await messageCursor(cursor.beforeId)
                        : null;
                    const newer = cursor?.afterId
                        ? await messageCursor(cursor.afterId)
                        : null;
                    const beforeSeq =
                        cursor?.beforeSeq ?? older?.seq ?? undefined;
                    const afterSeq =
                        cursor?.afterSeq ?? newer?.seq ?? undefined;
                    const beforeInclusive =
                        cursor?.beforeSeq === undefined && older !== null;
                    const afterInclusive =
                        cursor?.afterSeq === undefined && newer !== null;
                    if (beforeSeq === undefined) {
                        if (cursor?.before)
                            conds.push(
                                lt(
                                    messagesPg.createdAt,
                                    new Date(cursor.before),
                                ),
                            );
                    } else if (beforeInclusive)
                        conds.push(lte(messagesPg.seq, beforeSeq));
                    else conds.push(lt(messagesPg.seq, beforeSeq));
                    if (afterSeq === undefined) {
                        if (cursor?.after)
                            conds.push(
                                gt(
                                    messagesPg.createdAt,
                                    new Date(cursor.after),
                                ),
                            );
                    } else if (afterInclusive)
                        conds.push(gte(messagesPg.seq, afterSeq));
                    else conds.push(gt(messagesPg.seq, afterSeq));
                    const up =
                        forward ||
                        Boolean(newer) ||
                        Boolean(!older && cursor?.after);
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(and(...conds))
                        .orderBy(
                            up ? asc(messagesPg.seq) : desc(messagesPg.seq),
                            up
                                ? asc(messagesPg.createdAt)
                                : desc(messagesPg.createdAt),
                            up ? asc(messagesPg.id) : desc(messagesPg.id),
                        )
                        .limit(limit);
                    const list = rows.map(messageRowToChat);
                    return up ? list : list.reverse();
                },
                async lastSeq(session) {
                    const rows = await db
                        .select({
                            max: sql<number>`coalesce(max(${messagesPg.seq}), 0)`,
                        })
                        .from(messagesPg)
                        .where(eq(messagesPg.session, session));
                    return Number(rows[0]?.max ?? 0);
                },
                async summaries({ userId, username, sessions }) {
                    if (sessions.length === 0) return [];
                    const grouped = await db
                        .select({
                            session: messagesPg.session,
                            lastSeq: sql<number>`max(${messagesPg.seq})`,
                            readSeq: sql<number>`max(coalesce(${readsPg.seq}, 0))`,
                            unread: sql<number>`count(*) filter (
                                where ${messagesPg.seq} > coalesce(${readsPg.seq}, 0)
                                and ${messagesPg.sender} <> ${username}
                            )`,
                        })
                        .from(messagesPg)
                        .leftJoin(
                            readsPg,
                            and(
                                eq(readsPg.session, messagesPg.session),
                                eq(readsPg.userId, userId),
                            ),
                        )
                        .where(inArray(messagesPg.session, sessions))
                        .groupBy(messagesPg.session);
                    const stats = new Map(
                        grouped.map((row) => [
                            row.session,
                            {
                                lastSeq: Number(row.lastSeq ?? 0),
                                readSeq: Number(row.readSeq ?? 0),
                                unread: Number(row.unread ?? 0),
                            },
                        ]),
                    );
                    const latestConds = sessions
                        .map((session) => ({ session, ...stats.get(session) }))
                        .filter(
                            (
                                entry,
                            ): entry is typeof entry & {
                                lastSeq: number;
                            } => (entry.lastSeq ?? 0) > 0,
                        )
                        .map((entry) =>
                            and(
                                eq(messagesPg.session, entry.session),
                                eq(messagesPg.seq, entry.lastSeq),
                            ),
                        );
                    const latest =
                        latestConds.length > 0
                            ? await db
                                  .select()
                                  .from(messagesPg)
                                  .where(
                                      latestConds.length === 1
                                          ? latestConds[0]
                                          : or(...latestConds),
                                  )
                            : [];
                    const lastBySession = new Map<string, ChatMessage>();
                    for (const row of latest)
                        lastBySession.set(row.session, messageRowToChat(row));
                    return sessions.map((session) => ({
                        session,
                        lastSeq: stats.get(session)?.lastSeq ?? 0,
                        readSeq: stats.get(session)?.readSeq ?? 0,
                        unread: stats.get(session)?.unread ?? 0,
                        lastMessage: lastBySession.get(session) ?? null,
                    }));
                },
                async since({ session, seq, limit }) {
                    const rows = await db
                        .select()
                        .from(messagesPg)
                        .where(
                            and(
                                eq(messagesPg.session, session),
                                gt(messagesPg.seq, seq),
                            ),
                        )
                        .orderBy(asc(messagesPg.seq), asc(messagesPg.id))
                        .limit(limit);
                    return rows.map(messageRowToChat);
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
                async setReactions(id, reactions) {
                    const rows = await db
                        .update(messagesPg)
                        .set({ reactions: serializeReactions(reactions) })
                        .where(eq(messagesPg.id, id))
                        .returning();
                    const row = rows[0];
                    return row ? messageRowToChat(row) : null;
                },
                async edit(id, content, at) {
                    const rows = await db
                        .update(messagesPg)
                        .set({
                            content,
                            editedAt: new Date(at),
                            editCount: sql`${messagesPg.editCount} + 1`,
                        })
                        .where(eq(messagesPg.id, id))
                        .returning();
                    const row = rows[0];
                    return row ? messageRowToChat(row) : null;
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
                    if (params.from) {
                        const from = Date.parse(params.from);
                        if (Number.isFinite(from))
                            conds.push(
                                gte(messagesPg.createdAt, new Date(from)),
                            );
                    }
                    if (params.to) {
                        const to = Date.parse(params.to);
                        if (Number.isFinite(to))
                            conds.push(lte(messagesPg.createdAt, new Date(to)));
                    }
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
                            deptId: row.deptId,
                            title: row.title,
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
                async setOrg(id, deptId, title) {
                    await db
                        .update(usersPg)
                        .set({ deptId, title })
                        .where(eq(usersPg.id, id));
                },
                async setMustChange(id, on) {
                    await db
                        .update(usersPg)
                        .set({ mustChangePassword: on })
                        .where(eq(usersPg.id, id));
                },
                async totpOf(id) {
                    const rows = await db
                        .select({ secret: usersPg.totpSecret })
                        .from(usersPg)
                        .where(eq(usersPg.id, id))
                        .limit(1);
                    return rows[0]?.secret ?? null;
                },
                async setTotp(id, secret) {
                    await db
                        .update(usersPg)
                        .set({ totpSecret: secret })
                        .where(eq(usersPg.id, id));
                },
                async count() {
                    const rows = await db
                        .select({ id: usersPg.id })
                        .from(usersPg);
                    return rows.length;
                },
            };

            departments = {
                async create(name, parentId) {
                    const id = crypto.randomUUID();
                    const siblings = await db
                        .select({ sort: departmentsPg.sort })
                        .from(departmentsPg)
                        .where(
                            parentId === null
                                ? isNull(departmentsPg.parentId)
                                : eq(departmentsPg.parentId, parentId),
                        );
                    const sort =
                        siblings.reduce(
                            (max, row) => Math.max(max, row.sort),
                            0,
                        ) + 1;
                    const rows = await db
                        .insert(departmentsPg)
                        .values({ id, name, parentId, sort })
                        .returning();
                    const row = rows[0];
                    return {
                        id: row.id,
                        name: row.name,
                        parentId: row.parentId,
                        sort: row.sort,
                        groupId: row.groupId,
                        createdAt: toIso(row.createdAt),
                    };
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(departmentsPg)
                        .where(eq(departmentsPg.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row
                        ? {
                              id: row.id,
                              name: row.name,
                              parentId: row.parentId,
                              sort: row.sort,
                              groupId: row.groupId,
                              createdAt: toIso(row.createdAt),
                          }
                        : null;
                },
                async listAll() {
                    const rows = await db
                        .select()
                        .from(departmentsPg)
                        .orderBy(
                            asc(departmentsPg.sort),
                            asc(departmentsPg.createdAt),
                        );
                    return rows.map(
                        (row): DepartmentRow => ({
                            id: row.id,
                            name: row.name,
                            parentId: row.parentId,
                            sort: row.sort,
                            groupId: row.groupId,
                            createdAt: toIso(row.createdAt),
                        }),
                    );
                },
                async rename(id, name) {
                    await db
                        .update(departmentsPg)
                        .set({ name })
                        .where(eq(departmentsPg.id, id));
                },
                async move(id, parentId) {
                    await db
                        .update(departmentsPg)
                        .set({ parentId })
                        .where(eq(departmentsPg.id, id));
                },
                async remove(id) {
                    await db
                        .delete(departmentsPg)
                        .where(eq(departmentsPg.id, id));
                },
                async setGroup(id, groupId) {
                    await db
                        .update(departmentsPg)
                        .set({ groupId })
                        .where(eq(departmentsPg.id, id));
                },
                async memberCounts() {
                    const rows = await db
                        .select({ deptId: usersPg.deptId })
                        .from(usersPg);
                    const counts: Record<string, number> = {};
                    for (const row of rows) {
                        if (!row.deptId) continue;
                        counts[row.deptId] = (counts[row.deptId] ?? 0) + 1;
                    }
                    return counts;
                },
            };

            audits = {
                async add(row) {
                    await db.insert(auditsPg).values({
                        id: crypto.randomUUID(),
                        actorId: row.actorId,
                        actor: row.actor,
                        action: row.action,
                        detail: row.detail,
                    });
                },
                async list(query) {
                    const conds = [];
                    const keyword = query.keyword?.trim();
                    if (keyword) {
                        const like = `%${keyword}%`;
                        conds.push(
                            sql`(${auditsPg.actor} LIKE ${like} OR ${auditsPg.detail} LIKE ${like})`,
                        );
                    }
                    if (query.category)
                        conds.push(
                            sql`${auditsPg.action} LIKE ${`${query.category}.%`}`,
                        );
                    const where = conds.length ? and(...conds) : undefined;
                    const countRows = await db
                        .select({ count: sql<number>`count(*)` })
                        .from(auditsPg)
                        .where(where);
                    const rows = await db
                        .select()
                        .from(auditsPg)
                        .where(where)
                        .orderBy(desc(auditsPg.createdAt))
                        .limit(query.limit)
                        .offset(query.offset);
                    return {
                        total: Number(countRows[0]?.count ?? 0),
                        rows: rows.map(
                            (row): AuditRow => ({
                                id: row.id,
                                actorId: row.actorId,
                                actor: row.actor,
                                action: row.action,
                                detail: row.detail,
                                createdAt: toIso(row.createdAt),
                            }),
                        ),
                    };
                },
            };

            authSessions = {
                async create(input) {
                    const now = new Date();
                    await db.insert(authSessionsPg).values({
                        id: input.id,
                        userId: input.userId,
                        label: input.label,
                        userAgent: input.userAgent,
                        ip: input.ip,
                        createdAt: now,
                        lastSeenAt: now,
                    });
                    return {
                        id: input.id,
                        label: input.label,
                        userAgent: input.userAgent,
                        ip: input.ip,
                        createdAt: now.toISOString(),
                        lastSeenAt: now.toISOString(),
                        revoked: false,
                    };
                },
                async touch(id) {
                    await db
                        .update(authSessionsPg)
                        .set({ lastSeenAt: new Date() })
                        .where(
                            and(
                                eq(authSessionsPg.id, id),
                                isNull(authSessionsPg.revokedAt),
                            ),
                        );
                },
                async list(userId) {
                    const rows = await db
                        .select()
                        .from(authSessionsPg)
                        .where(eq(authSessionsPg.userId, userId))
                        .orderBy(desc(authSessionsPg.lastSeenAt))
                        .limit(50);
                    return rows.map(authDeviceOf);
                },
                async rename(userId, id, label) {
                    const rows = await db
                        .update(authSessionsPg)
                        .set({ label })
                        .where(
                            and(
                                eq(authSessionsPg.id, id),
                                eq(authSessionsPg.userId, userId),
                            ),
                        )
                        .returning();
                    return rows.length > 0;
                },
                async revoke(userId, id) {
                    const rows = await db
                        .update(authSessionsPg)
                        .set({ revokedAt: new Date() })
                        .where(
                            and(
                                eq(authSessionsPg.id, id),
                                eq(authSessionsPg.userId, userId),
                                isNull(authSessionsPg.revokedAt),
                            ),
                        )
                        .returning();
                    return rows.length > 0;
                },
                async revokeOthers(userId, keepId) {
                    const rows = await db
                        .update(authSessionsPg)
                        .set({ revokedAt: new Date() })
                        .where(
                            and(
                                eq(authSessionsPg.userId, userId),
                                ne(authSessionsPg.id, keepId),
                                isNull(authSessionsPg.revokedAt),
                            ),
                        )
                        .returning();
                    return rows.length;
                },
                async isActive(userId, id) {
                    const rows = await db
                        .select({ id: authSessionsPg.id })
                        .from(authSessionsPg)
                        .where(
                            and(
                                eq(authSessionsPg.id, id),
                                eq(authSessionsPg.userId, userId),
                                isNull(authSessionsPg.revokedAt),
                            ),
                        )
                        .limit(1);
                    return rows.length > 0;
                },
            };

            bots = {
                async createApp(input) {
                    const id = crypto.randomUUID();
                    const now = new Date();
                    await db.insert(botAppsPg).values({
                        id,
                        ownerId: input.ownerId,
                        name: input.name,
                        tokenHash: input.tokenHash,
                        scopes: serializeScopes(input.scopes),
                        createdAt: now,
                    });
                    const owner = await accounts.byId(input.ownerId);
                    return {
                        id,
                        ownerId: input.ownerId,
                        owner: owner?.username ?? "",
                        name: input.name,
                        tokenHash: input.tokenHash,
                        scopes: input.scopes,
                        createdAt: now.toISOString(),
                        lastUsedAt: null,
                        revoked: false,
                    };
                },
                async listApps(ownerId) {
                    const rows = await db
                        .select()
                        .from(botAppsPg)
                        .where(eq(botAppsPg.ownerId, ownerId))
                        .orderBy(desc(botAppsPg.createdAt))
                        .limit(50);
                    const owner = await accounts.byId(ownerId);
                    return rows.map((row) =>
                        botAppOf(row, owner?.username ?? ""),
                    );
                },
                async revokeApp(ownerId, id) {
                    const rows = await db
                        .update(botAppsPg)
                        .set({ revokedAt: new Date() })
                        .where(
                            and(
                                eq(botAppsPg.id, id),
                                eq(botAppsPg.ownerId, ownerId),
                                isNull(botAppsPg.revokedAt),
                            ),
                        )
                        .returning();
                    return rows.length > 0;
                },
                async byToken(tokenHash) {
                    const rows = await db
                        .select()
                        .from(botAppsPg)
                        .where(
                            and(
                                eq(botAppsPg.tokenHash, tokenHash),
                                isNull(botAppsPg.revokedAt),
                            ),
                        )
                        .limit(1);
                    const row = rows[0];
                    if (!row) return null;
                    const owner = await accounts.byId(row.ownerId);
                    await db
                        .update(botAppsPg)
                        .set({ lastUsedAt: new Date() })
                        .where(eq(botAppsPg.id, row.id));
                    return botAppOf(row, owner?.username ?? "");
                },
                async createHook(input) {
                    const id = crypto.randomUUID();
                    const now = new Date();
                    await db.insert(botHooksPg).values({
                        id,
                        botId: input.botId,
                        url: input.url,
                        secret: input.secret,
                        events: JSON.stringify(input.events),
                        enabled: true,
                        createdAt: now,
                    });
                    const bot = await db
                        .select({ name: botAppsPg.name })
                        .from(botAppsPg)
                        .where(eq(botAppsPg.id, input.botId))
                        .limit(1);
                    return {
                        id,
                        botId: input.botId,
                        botName: bot[0]?.name ?? "",
                        url: input.url,
                        secret: input.secret,
                        events: input.events,
                        enabled: true,
                        failures: 0,
                        lastError: null,
                        createdAt: now.toISOString(),
                    };
                },
                async listHooks(ownerId) {
                    const rows = await db
                        .select({ hook: botHooksPg, name: botAppsPg.name })
                        .from(botHooksPg)
                        .innerJoin(
                            botAppsPg,
                            eq(botAppsPg.id, botHooksPg.botId),
                        )
                        .where(eq(botAppsPg.ownerId, ownerId))
                        .orderBy(desc(botHooksPg.createdAt))
                        .limit(100);
                    return rows.map((row) =>
                        botHookOf(row.hook, row.name ?? ""),
                    );
                },
                async setHookEnabled(ownerId, id, enabled) {
                    const owned = await db
                        .select({ id: botHooksPg.id })
                        .from(botHooksPg)
                        .innerJoin(
                            botAppsPg,
                            eq(botAppsPg.id, botHooksPg.botId),
                        )
                        .where(
                            and(
                                eq(botHooksPg.id, id),
                                eq(botAppsPg.ownerId, ownerId),
                            ),
                        )
                        .limit(1);
                    if (owned.length === 0) return false;
                    await db
                        .update(botHooksPg)
                        .set({ enabled, lastError: null })
                        .where(eq(botHooksPg.id, id));
                    return true;
                },
                async removeHook(ownerId, id) {
                    const owned = await db
                        .select({ id: botHooksPg.id })
                        .from(botHooksPg)
                        .innerJoin(
                            botAppsPg,
                            eq(botAppsPg.id, botHooksPg.botId),
                        )
                        .where(
                            and(
                                eq(botHooksPg.id, id),
                                eq(botAppsPg.ownerId, ownerId),
                            ),
                        )
                        .limit(1);
                    if (owned.length === 0) return false;
                    await db.delete(botHooksPg).where(eq(botHooksPg.id, id));
                    return true;
                },
                async hooksOfEvent(event) {
                    const rows = await db
                        .select({ hook: botHooksPg, name: botAppsPg.name })
                        .from(botHooksPg)
                        .innerJoin(
                            botAppsPg,
                            eq(botAppsPg.id, botHooksPg.botId),
                        )
                        .where(
                            and(
                                eq(botHooksPg.enabled, true),
                                isNull(botAppsPg.revokedAt),
                            ),
                        )
                        .limit(500);
                    return rows
                        .filter((row) =>
                            parseIdList(row.hook.events).includes(event),
                        )
                        .map((row) => botHookOf(row.hook, row.name ?? ""));
                },
                async reportHook(id, ok, error) {
                    await db
                        .update(botHooksPg)
                        .set({
                            failures: ok ? 0 : sql`${botHooksPg.failures} + 1`,
                            lastError: error,
                        })
                        .where(eq(botHooksPg.id, id));
                },
            };

            friends = {
                async request(requesterId, addresseeId, message) {
                    await db
                        .insert(friendshipsPg)
                        .values({
                            requesterId,
                            addresseeId,
                            status: "pending",
                            createdAt: new Date(),
                            message: message ?? null,
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
                async starsOf(ownerId) {
                    const rows = await db
                        .select({ friendId: friendStarsPg.friendId })
                        .from(friendStarsPg)
                        .where(eq(friendStarsPg.ownerId, ownerId));
                    return rows.map((row) => row.friendId);
                },
                async setStar(ownerId, friendId, on) {
                    if (!on) {
                        await db
                            .delete(friendStarsPg)
                            .where(
                                and(
                                    eq(friendStarsPg.ownerId, ownerId),
                                    eq(friendStarsPg.friendId, friendId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(friendStarsPg)
                        .values({ ownerId, friendId })
                        .onConflictDoNothing();
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
                async setOwner(id, ownerId) {
                    await db
                        .update(groupsPg)
                        .set({ ownerId })
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
                async setMemberTitle(groupId, userId, title) {
                    await db
                        .update(groupMembersPg)
                        .set({ title })
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
                            title: row.title,
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
                async set(userId, session, at, seq) {
                    const readAt = new Date(at);
                    await db
                        .insert(readsPg)
                        .values({ userId, session, readAt, seq: seq ?? 0 })
                        .onConflictDoUpdate({
                            target: [readsPg.userId, readsPg.session],
                            set: {
                                readAt,
                                seq: sql`greatest(${readsPg.seq}, ${seq ?? 0})`,
                            },
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
                        seq: row.seq,
                    }));
                },
                async cursorsOf(userId) {
                    const rows = await db
                        .select()
                        .from(readsPg)
                        .where(eq(readsPg.userId, userId));
                    return Object.fromEntries(
                        rows.map((row) => [row.session, row.seq]),
                    );
                },
            };

            sessionMeta = {
                async of(userId) {
                    const rows = await db
                        .select()
                        .from(sessionMetaPg)
                        .where(eq(sessionMetaPg.userId, userId));
                    return rows.map((row) => ({
                        session: row.session,
                        pinned: row.pinned,
                    }));
                },
                async ofSession(userId, session) {
                    const rows = await db
                        .select()
                        .from(sessionMetaPg)
                        .where(
                            and(
                                eq(sessionMetaPg.userId, userId),
                                eq(sessionMetaPg.session, session),
                            ),
                        )
                        .limit(1);
                    const row = rows[0];
                    return row
                        ? {
                              session: row.session,
                              pinned: row.pinned,
                          }
                        : null;
                },
                async set(userId, session, patch) {
                    const rows = await db
                        .insert(sessionMetaPg)
                        .values({
                            userId,
                            session,
                            pinned: patch.pinned ?? false,
                        })
                        .onConflictDoUpdate({
                            target: [
                                sessionMetaPg.userId,
                                sessionMetaPg.session,
                            ],
                            set: {
                                ...(patch.pinned === undefined
                                    ? {}
                                    : { pinned: patch.pinned }),
                            },
                        })
                        .returning();
                    const row = rows[0];
                    return {
                        session: row.session,
                        pinned: row.pinned,
                    };
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
                async remove(userId: string, endpoint: string) {
                    await db
                        .delete(pushPg)
                        .where(
                            and(
                                eq(pushPg.endpoint, endpoint),
                                eq(pushPg.userId, userId),
                            ),
                        );
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
                async commentById(id) {
                    const rows = await db
                        .select()
                        .from(momentCommentsPg)
                        .where(eq(momentCommentsPg.id, id))
                        .limit(1);
                    return rows[0] ? momentCommentToRow(rows[0]) : null;
                },
                async removeComment(id) {
                    await db
                        .delete(momentCommentsPg)
                        .where(eq(momentCommentsPg.id, id));
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

            redPackets = {
                async create(input) {
                    await db.insert(redPacketsPg).values({
                        id: input.id,
                        sessionId: input.sessionId,
                        senderId: input.senderId,
                        type: input.type,
                        totalAmount: input.totalAmount,
                        totalCount: input.totalCount,
                        remaining: input.totalAmount,
                        remainCount: input.totalCount,
                        status: "active",
                        message: input.message ?? null,
                        createdAt: new Date(input.createdAt),
                        expiredAt: input.expiredAt
                            ? new Date(input.expiredAt)
                            : null,
                    });
                },
                async getById(id) {
                    const rows = await db
                        .select()
                        .from(redPacketsPg)
                        .where(eq(redPacketsPg.id, id))
                        .limit(1);
                    return rows[0] ? pgPacketToRow(rows[0]) : null;
                },
                async claimedBy(redPacketId, claimerId) {
                    const rows = await db
                        .select({ amount: redPacketRecordsPg.amount })
                        .from(redPacketRecordsPg)
                        .where(
                            and(
                                eq(redPacketRecordsPg.redPacketId, redPacketId),
                                eq(redPacketRecordsPg.claimerId, claimerId),
                            ),
                        )
                        .limit(1);
                    return rows[0] ? rows[0].amount : null;
                },
                async listRecords(redPacketId) {
                    const rows = await db
                        .select()
                        .from(redPacketRecordsPg)
                        .where(eq(redPacketRecordsPg.redPacketId, redPacketId))
                        .orderBy(asc(redPacketRecordsPg.claimedAt));
                    return rows.map((row) => ({
                        id: row.id,
                        redPacketId: row.redPacketId,
                        claimerId: row.claimerId,
                        amount: row.amount,
                        claimedAt: row.claimedAt.toISOString(),
                    }));
                },
                async listSession(sessionId) {
                    const rows = await db
                        .select()
                        .from(redPacketsPg)
                        .where(eq(redPacketsPg.sessionId, sessionId))
                        .orderBy(desc(redPacketsPg.createdAt))
                        .limit(100);
                    return rows.map(pgPacketToRow);
                },
                async claim(input) {
                    return db.transaction(async (tx) => {
                        const locked = await tx
                            .select()
                            .from(redPacketsPg)
                            .where(eq(redPacketsPg.id, input.redPacketId))
                            .for("update");
                        const packet = locked[0];
                        if (!packet)
                            return {
                                ok: false as const,
                                reason: "missing" as const,
                            };
                        const dup = await tx
                            .select({ id: redPacketRecordsPg.id })
                            .from(redPacketRecordsPg)
                            .where(
                                and(
                                    eq(
                                        redPacketRecordsPg.redPacketId,
                                        input.redPacketId,
                                    ),
                                    eq(
                                        redPacketRecordsPg.claimerId,
                                        input.claimerId,
                                    ),
                                ),
                            )
                            .limit(1);
                        if (dup)
                            return {
                                ok: false as const,
                                reason: "duplicate" as const,
                            };
                        if (
                            packet.status !== "active" ||
                            packet.remainCount <= 0 ||
                            packet.remaining < input.amount
                        )
                            return {
                                ok: false as const,
                                reason: "empty" as const,
                            };
                        await tx.insert(redPacketRecordsPg).values({
                            id: input.recordId,
                            redPacketId: input.redPacketId,
                            claimerId: input.claimerId,
                            amount: input.amount,
                            claimedAt: new Date(input.claimedAt),
                        });
                        const remainCount = packet.remainCount - 1;
                        const remaining = packet.remaining - input.amount;
                        const exhausted = remainCount <= 0 || remaining <= 0;
                        const status = exhausted ? "exhausted" : packet.status;
                        await tx
                            .update(redPacketsPg)
                            .set({ remainCount, remaining, status })
                            .where(eq(redPacketsPg.id, input.redPacketId));
                        return {
                            ok: true as const,
                            packet: {
                                ...pgPacketToRow(packet),
                                remainCount,
                                remaining,
                                status: status as RedPacketRow["status"],
                            },
                        };
                    });
                },
                async expireIfNeeded(now) {
                    const rows = await db
                        .select({ id: redPacketsPg.id })
                        .from(redPacketsPg)
                        .where(
                            and(
                                eq(redPacketsPg.status, "active"),
                                lte(redPacketsPg.expiredAt, new Date(now)),
                            ),
                        );
                    if (rows.length === 0) return [];
                    await db
                        .update(redPacketsPg)
                        .set({ status: "expired" })
                        .where(
                            inArray(
                                redPacketsPg.id,
                                rows.map((row) => row.id),
                            ),
                        );
                    return rows.map((row) => row.id);
                },
                async claimBack(redPacketId, input) {
                    const packet = await db
                        .select({
                            remaining: redPacketsPg.remaining,
                            remainCount: redPacketsPg.remainCount,
                            status: redPacketsPg.status,
                        })
                        .from(redPacketsPg)
                        .where(eq(redPacketsPg.id, redPacketId))
                        .limit(1);
                    const row = packet[0];
                    if (!row) return { ...EMPTY_CLAIM_BACK };
                    const records = await db
                        .select({ claimedAt: redPacketRecordsPg.claimedAt })
                        .from(redPacketRecordsPg)
                        .where(eq(redPacketRecordsPg.redPacketId, redPacketId))
                        .orderBy(desc(redPacketRecordsPg.claimedAt))
                        .limit(1);
                    const claimedCount = await db
                        .select({ id: redPacketRecordsPg.id })
                        .from(redPacketRecordsPg)
                        .where(eq(redPacketRecordsPg.redPacketId, redPacketId));
                    const count = claimedCount.length;
                    if (row.status !== "active")
                        return {
                            status: row.status as RedPacketRow["status"],
                            remaining: row.remaining,
                            remainCount: row.remainCount,
                            claimedCount: count,
                        };
                    const latest = records[0]?.claimedAt;
                    if (
                        latest &&
                        latest.getTime() > new Date(input.at).getTime()
                    )
                        return {
                            status: row.status as RedPacketRow["status"],
                            remaining: row.remaining,
                            remainCount: row.remainCount,
                            claimedCount: count,
                        };
                    await db
                        .update(redPacketsPg)
                        .set({ status: "expired" })
                        .where(eq(redPacketsPg.id, redPacketId));
                    return {
                        status: "expired" as const,
                        remaining: row.remaining,
                        remainCount: row.remainCount,
                        claimedCount: count,
                    };
                },
            };

            const transferRowOf = (
                row: typeof transfersPg.$inferSelect,
            ): TransferRow => ({
                id: row.id,
                sessionId: row.session,
                fromId: row.fromId,
                toId: row.toId,
                amount: row.amount,
                message: row.message,
                state: row.state as TransferState,
                createdAt: row.createdAt.toISOString(),
                expiredAt: row.expiredAt.toISOString(),
            });

            const billRowOf = (
                row: typeof aaBillsPg.$inferSelect,
            ): AABillRow => ({
                id: row.id,
                sessionId: row.session,
                creatorId: row.creatorId,
                description: row.description,
                totalAmount: row.totalAmount,
                settledAmount: row.settledAmount,
                participantIds: parseIdList(row.participantIds),
                splitType: row.splitType as AABillRow["splitType"],
                customSplits: parseSplitMap(row.customSplits),
                status: row.status as AABillRow["status"],
                createdAt: row.createdAt.toISOString(),
                deadline: row.deadline.toISOString(),
            });

            const paymentRowOf = (
                row: typeof aaPaymentsPg.$inferSelect,
            ): AAPaymentRow => ({
                id: row.id,
                billId: row.billId,
                payerId: row.payerId,
                amount: row.amount,
                paidAt: row.paidAt.toISOString(),
            });

            const pgBalance = async (userId: string): Promise<number> => {
                const rows = await db
                    .select({ balance: usersPg.balance })
                    .from(usersPg)
                    .where(eq(usersPg.id, userId))
                    .limit(1);
                return rows[0]?.balance ?? 0;
            };

            const pgAddBalance = async (
                tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
                userId: string,
                delta: number,
            ): Promise<void> => {
                if (delta === 0) return;
                await tx
                    .update(usersPg)
                    .set({ balance: sql`${usersPg.balance} + ${delta}` })
                    .where(eq(usersPg.id, userId));
            };

            wallet = {
                async balanceOf(userId) {
                    return pgBalance(userId);
                },
                async balancesOf(userIds) {
                    if (userIds.length === 0) return {};
                    const rows = await db
                        .select({
                            id: usersPg.id,
                            balance: usersPg.balance,
                        })
                        .from(usersPg)
                        .where(inArray(usersPg.id, userIds));
                    return Object.fromEntries(
                        rows.map((row) => [row.id, row.balance]),
                    );
                },
                async adjustBalance(userId, delta) {
                    return db.transaction(async (tx) => {
                        const rows = await tx
                            .select({ balance: usersPg.balance })
                            .from(usersPg)
                            .where(eq(usersPg.id, userId))
                            .limit(1)
                            .for("update");
                        const current = rows[0];
                        if (!current) throw new Error("用户不存在");
                        const next = current.balance + delta;
                        if (next < 0) throw new Error("余额不足");
                        await tx
                            .update(usersPg)
                            .set({ balance: next })
                            .where(eq(usersPg.id, userId));
                        return next;
                    });
                },
                async transferCreate(input) {
                    return db.transaction(async (tx) => {
                        const dup = await tx
                            .select({ id: transfersPg.id })
                            .from(transfersPg)
                            .where(eq(transfersPg.id, input.id))
                            .limit(1);
                        if (dup.length > 0)
                            return {
                                ok: false as const,
                                reason: "duplicate" as const,
                            };
                        const rows = await tx
                            .select({ balance: usersPg.balance })
                            .from(usersPg)
                            .where(eq(usersPg.id, input.fromId))
                            .limit(1)
                            .for("update");
                        if (rows.length === 0)
                            return {
                                ok: false as const,
                                reason: "missing" as const,
                            };
                        if (rows[0].balance < input.amount)
                            return {
                                ok: false as const,
                                reason: "insufficient" as const,
                            };
                        await pgAddBalance(tx, input.fromId, -input.amount);
                        const inserted = await tx
                            .insert(transfersPg)
                            .values({
                                id: input.id,
                                session: input.sessionId,
                                fromId: input.fromId,
                                toId: input.toId,
                                amount: input.amount,
                                message: input.message ?? null,
                                state: "pending",
                                createdAt: new Date(input.createdAt),
                                expiredAt: new Date(input.expiredAt),
                            })
                            .returning();
                        return {
                            ok: true as const,
                            transfer: transferRowOf(inserted[0]),
                        };
                    });
                },
                async transferGet(id) {
                    const rows = await db
                        .select()
                        .from(transfersPg)
                        .where(eq(transfersPg.id, id))
                        .limit(1);
                    return rows[0] ? transferRowOf(rows[0]) : null;
                },
                async transferSettle(id, action) {
                    return db.transaction(async (tx) => {
                        const rows = await tx
                            .select()
                            .from(transfersPg)
                            .where(eq(transfersPg.id, id))
                            .limit(1)
                            .for("update");
                        const row = rows[0];
                        if (!row)
                            return {
                                ok: false as const,
                                reason: "missing" as const,
                            };
                        if (row.state !== "pending")
                            return {
                                ok: false as const,
                                reason: "conflict" as const,
                            };
                        const next: TransferState =
                            action === "accept" ? "accepted" : "rejected";
                        if (action === "accept")
                            await pgAddBalance(tx, row.toId, row.amount);
                        else await pgAddBalance(tx, row.fromId, row.amount);
                        const updated = await tx
                            .update(transfersPg)
                            .set({ state: next })
                            .where(eq(transfersPg.id, id))
                            .returning();
                        return {
                            ok: true as const,
                            transfer: transferRowOf(updated[0]),
                        };
                    });
                },
                async transferExpireIfNeeded() {
                    const rows = await db
                        .select()
                        .from(transfersPg)
                        .where(
                            and(
                                eq(transfersPg.state, "pending"),
                                lte(transfersPg.expiredAt, new Date()),
                            ),
                        );
                    if (rows.length === 0) return [];
                    await db.transaction(async (tx) => {
                        for (const row of rows) {
                            await pgAddBalance(tx, row.fromId, row.amount);
                            await tx
                                .update(transfersPg)
                                .set({ state: "refunded" })
                                .where(eq(transfersPg.id, row.id));
                        }
                    });
                    return rows.map((row) => row.id);
                },
                async transferListForUser(userId) {
                    const rows = await db
                        .select()
                        .from(transfersPg)
                        .where(
                            or(
                                eq(transfersPg.fromId, userId),
                                eq(transfersPg.toId, userId),
                            ),
                        )
                        .orderBy(desc(transfersPg.createdAt))
                        .limit(200);
                    return rows.map(transferRowOf);
                },
                async transferListSession(sessionId) {
                    const rows = await db
                        .select()
                        .from(transfersPg)
                        .where(eq(transfersPg.session, sessionId))
                        .orderBy(desc(transfersPg.createdAt))
                        .limit(100);
                    return rows.map(transferRowOf);
                },
                async aaCreate(input) {
                    await db.insert(aaBillsPg).values({
                        id: input.id,
                        session: input.sessionId,
                        creatorId: input.creatorId,
                        description: input.description,
                        totalAmount: input.totalAmount,
                        settledAmount: 0,
                        participantIds: JSON.stringify(input.participantIds),
                        splitType: input.splitType,
                        customSplits: JSON.stringify(input.customSplits),
                        status: "pending",
                        createdAt: new Date(input.createdAt),
                        deadline: new Date(input.deadline),
                    });
                },
                async aaGetById(id) {
                    const rows = await db
                        .select()
                        .from(aaBillsPg)
                        .where(eq(aaBillsPg.id, id))
                        .limit(1);
                    return rows[0] ? billRowOf(rows[0]) : null;
                },
                async aaListSession(sessionId) {
                    const rows = await db
                        .select()
                        .from(aaBillsPg)
                        .where(eq(aaBillsPg.session, sessionId))
                        .orderBy(desc(aaBillsPg.createdAt))
                        .limit(100);
                    return rows.map(billRowOf);
                },
                async aaListForUser(userId) {
                    const rows = await db
                        .select()
                        .from(aaBillsPg)
                        .where(
                            sql`${aaBillsPg.creatorId} = ${userId} OR ${aaBillsPg.participantIds} LIKE ${`%${userId}%`}`,
                        )
                        .orderBy(desc(aaBillsPg.createdAt))
                        .limit(200);
                    return rows
                        .map(billRowOf)
                        .filter(
                            (bill) =>
                                bill.creatorId === userId ||
                                bill.participantIds.includes(userId),
                        );
                },
                async aaPayments(billId) {
                    const rows = await db
                        .select()
                        .from(aaPaymentsPg)
                        .where(eq(aaPaymentsPg.billId, billId))
                        .orderBy(asc(aaPaymentsPg.paidAt));
                    return rows.map(paymentRowOf);
                },
                async aaPay(input) {
                    return db.transaction(async (tx): Promise<AAPayResult> => {
                        const rows = await tx
                            .select()
                            .from(aaBillsPg)
                            .where(eq(aaBillsPg.id, input.billId))
                            .limit(1)
                            .for("update");
                        const bill = rows[0];
                        if (!bill)
                            return {
                                ok: false as const,
                                reason: "missing" as const,
                            };
                        if (bill.status !== "pending")
                            return {
                                ok: false as const,
                                reason: "closed" as const,
                            };
                        const dup = await tx
                            .select({ id: aaPaymentsPg.id })
                            .from(aaPaymentsPg)
                            .where(
                                and(
                                    eq(aaPaymentsPg.billId, input.billId),
                                    eq(aaPaymentsPg.payerId, input.payerId),
                                ),
                            )
                            .limit(1);
                        if (dup.length > 0)
                            return {
                                ok: false as const,
                                reason: "duplicate" as const,
                            };
                        const shares = splitOf(billRowOf(bill), input.payerId);
                        if (shares === null || shares !== input.amount)
                            return {
                                ok: false as const,
                                reason: "amount" as const,
                            };
                        const payerRows = await tx
                            .select({ balance: usersPg.balance })
                            .from(usersPg)
                            .where(eq(usersPg.id, input.payerId))
                            .limit(1)
                            .for("update");
                        if (payerRows.length === 0)
                            return {
                                ok: false as const,
                                reason: "missing" as const,
                            };
                        if (payerRows[0].balance < input.amount)
                            return {
                                ok: false as const,
                                reason: "insufficient" as const,
                            };
                        await pgAddBalance(tx, input.payerId, -input.amount);
                        await pgAddBalance(tx, bill.creatorId, input.amount);
                        const inserted = await tx
                            .insert(aaPaymentsPg)
                            .values({
                                id: input.paymentId,
                                billId: input.billId,
                                payerId: input.payerId,
                                amount: input.amount,
                                paidAt: new Date(input.paidAt),
                            })
                            .returning();
                        const settledAmount = bill.settledAmount + input.amount;
                        const done = settledAmount >= bill.totalAmount;
                        const updated = await tx
                            .update(aaBillsPg)
                            .set({
                                settledAmount,
                                status: done ? "settled" : "pending",
                            })
                            .where(eq(aaBillsPg.id, input.billId))
                            .returning();
                        return {
                            ok: true as const,
                            bill: billRowOf(updated[0]),
                            payment: paymentRowOf(inserted[0]),
                        };
                    });
                },
                async aaCancel(id) {
                    const updated = await db
                        .update(aaBillsPg)
                        .set({ status: "cancelled" })
                        .where(
                            and(
                                eq(aaBillsPg.id, id),
                                eq(aaBillsPg.status, "pending"),
                            ),
                        )
                        .returning();
                    return updated.length > 0;
                },
                async aaOverdue() {
                    const rows = await db
                        .select()
                        .from(aaBillsPg)
                        .where(
                            and(
                                eq(aaBillsPg.status, "pending"),
                                lt(aaBillsPg.deadline, new Date()),
                            ),
                        )
                        .orderBy(desc(aaBillsPg.createdAt))
                        .limit(100);
                    return rows.map(billRowOf);
                },
            };

            ctx.log.info(`storage driver: postgres (${config.dbUrl})`);
        } else {
            const file = resolve(process.cwd(), config.dbFile);
            mkdirSync(dirname(file), { recursive: true });
            const client = new Database(file);
            client.pragma("journal_mode = WAL");
            client.pragma("synchronous = NORMAL");
            client.pragma("busy_timeout = 5000");
            client.pragma("wal_autocheckpoint = 1000");
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
                "reactions",
                "red_packet",
                "transfer",
                "aa_bill",
            ]) {
                if (!messageColumns.some((item) => item.name === col)) {
                    const type = col === "recalled_at" ? "INTEGER" : "TEXT";
                    client.exec(
                        `ALTER TABLE messages ADD COLUMN ${col} ${type}`,
                    );
                }
            }
            if (!messageColumns.some((item) => item.name === "edited_at"))
                client.exec(
                    "ALTER TABLE messages ADD COLUMN edited_at INTEGER",
                );
            if (!messageColumns.some((item) => item.name === "edit_count"))
                client.exec(
                    "ALTER TABLE messages ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0",
                );
            if (!messageColumns.some((item) => item.name === "seq"))
                client.exec(
                    "ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
                );
            client.exec(
                "CREATE INDEX IF NOT EXISTS messages_session_seq_idx ON messages (session, seq)",
            );
            client.exec(
                `UPDATE messages SET seq = (
                    SELECT COUNT(*) FROM messages AS earlier
                    WHERE earlier.session = messages.session
                    AND (
                        earlier.created_at < messages.created_at
                        OR (
                            earlier.created_at = messages.created_at
                            AND earlier.id < messages.id
                        )
                    )
                ) + 1
                WHERE messages.seq = 0`,
            );
            let ftsEnabled = false;
            try {
                client.exec(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, message_id UNINDEXED, tokenize = 'trigram')",
                );
                client.exec(`
                    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
                        INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
                    END
                `);
                client.exec(`
                    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
                        DELETE FROM messages_fts WHERE message_id = old.id;
                    END
                `);
                client.exec(`
                    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
                        DELETE FROM messages_fts WHERE message_id = old.id;
                        INSERT INTO messages_fts(content, message_id) VALUES (new.content, new.id);
                    END
                `);
                client.exec(`
                    INSERT INTO messages_fts(content, message_id)
                    SELECT content, id FROM messages
                    WHERE id NOT IN (SELECT message_id FROM messages_fts)
                `);
                ftsEnabled = true;
            } catch (err) {
                ctx.log.warn(
                    "sqlite fts5 trigram unavailable, fallback to LIKE",
                    err,
                );
            }
            const userColumns = client.pragma("table_info(users)") as Array<{
                name: string;
            }>;
            for (const [col, type] of [
                ["is_admin", "INTEGER NOT NULL DEFAULT 0"],
                ["banned", "INTEGER NOT NULL DEFAULT 0"],
                ["token_version", "INTEGER NOT NULL DEFAULT 0"],
                ["dept_id", "TEXT"],
                ["title", "TEXT"],
                ["must_change_password", "INTEGER NOT NULL DEFAULT 0"],
                ["balance", "INTEGER NOT NULL DEFAULT 0"],
                ["totp_secret", "TEXT"],
            ]) {
                if (!userColumns.some((item) => item.name === col)) {
                    client.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
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
            const friendshipColumns = client.pragma(
                "table_info(friendships)",
            ) as Array<{ name: string }>;
            if (!friendshipColumns.some((item) => item.name === "message")) {
                client.exec("ALTER TABLE friendships ADD COLUMN message TEXT");
            }
            const momentColumns = client.pragma(
                "table_info(moments)",
            ) as Array<{ name: string }>;
            if (!momentColumns.some((item) => item.name === "video"))
                client.exec("ALTER TABLE moments ADD COLUMN video TEXT");
            if (!momentColumns.some((item) => item.name === "link"))
                client.exec("ALTER TABLE moments ADD COLUMN link TEXT");
            const groupMemberColumns = client.pragma(
                "table_info(group_members)",
            ) as Array<{ name: string }>;
            if (!groupMemberColumns.some((item) => item.name === "title"))
                client.exec("ALTER TABLE group_members ADD COLUMN title TEXT");
            const readColumns = client.pragma("table_info(reads)") as Array<{
                name: string;
            }>;
            if (!readColumns.some((item) => item.name === "seq"))
                client.exec(
                    "ALTER TABLE reads ADD COLUMN seq INTEGER NOT NULL DEFAULT 0",
                );
            const db = drizzleSqlite(client);

            const messageCursor = async (id: string) => {
                const rows = await db
                    .select({
                        id: messagesSqlite.id,
                        seq: messagesSqlite.seq,
                        createdAt: messagesSqlite.createdAt,
                    })
                    .from(messagesSqlite)
                    .where(eq(messagesSqlite.id, id))
                    .limit(1);
                const row = rows[0];
                return row
                    ? { id: row.id, seq: row.seq, at: row.createdAt }
                    : null;
            };

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
                deptId: row.deptId,
                title: row.title,
                mustChangePassword: row.mustChangePassword,
            });
            const edgeToRow = (row: {
                requesterId: string;
                addresseeId: string;
                status: string;
                createdAt: number;
                message: string | null;
            }): FriendEdge => ({
                requesterId: row.requesterId,
                addresseeId: row.addresseeId,
                status: row.status as FriendEdge["status"],
                createdAt: toIso(row.createdAt),
                message: row.message ?? null,
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
                        redPacket,
                        transfer,
                        aaBill,
                        ...rest
                    } = input;
                    const seq = client.transaction(() => {
                        const row = client
                            .prepare(
                                "SELECT coalesce(max(seq), 0) AS maxSeq FROM messages WHERE session = ?",
                            )
                            .get(rest.session) as { maxSeq: number };
                        return Number(row?.maxSeq ?? 0) + 1;
                    })();
                    await db.insert(messagesSqlite).values({
                        id,
                        ...rest,
                        seq,
                        quote: serializeQuote(quote),
                        mentions: serializeMentions(mentions),
                        file: meta ? JSON.stringify(meta) : null,
                        link: link ? JSON.stringify(link) : null,
                        redPacket: redPacket ? JSON.stringify(redPacket) : null,
                        transfer: transfer ? JSON.stringify(transfer) : null,
                        aaBill: aaBill ? JSON.stringify(aaBill) : null,
                        createdAt: now,
                    });
                    return {
                        id,
                        ...rest,
                        seq,
                        quote: quote ?? null,
                        mentions: mentions ?? null,
                        file: meta ?? null,
                        link: link ?? null,
                        redPacket: redPacket ?? null,
                        transfer: transfer ?? null,
                        aaBill: aaBill ?? null,
                        createdAt: new Date(now).toISOString(),
                        recalledAt: null,
                    };
                },
                async list(session, limit, cursor) {
                    const conds = [eq(messagesSqlite.session, session)];
                    const forward = cursor?.afterSeq !== undefined;
                    const older = cursor?.beforeId
                        ? await messageCursor(cursor.beforeId)
                        : null;
                    const newer = cursor?.afterId
                        ? await messageCursor(cursor.afterId)
                        : null;
                    const beforeSeq =
                        cursor?.beforeSeq ?? older?.seq ?? undefined;
                    const afterSeq =
                        cursor?.afterSeq ?? newer?.seq ?? undefined;
                    const beforeInclusive =
                        cursor?.beforeSeq === undefined && older !== null;
                    const afterInclusive =
                        cursor?.afterSeq === undefined && newer !== null;
                    if (beforeSeq === undefined) {
                        if (cursor?.before)
                            conds.push(
                                lt(
                                    messagesSqlite.createdAt,
                                    new Date(cursor.before).getTime(),
                                ),
                            );
                    } else if (beforeInclusive)
                        conds.push(lte(messagesSqlite.seq, beforeSeq));
                    else conds.push(lt(messagesSqlite.seq, beforeSeq));
                    if (afterSeq === undefined) {
                        if (cursor?.after)
                            conds.push(
                                gt(
                                    messagesSqlite.createdAt,
                                    new Date(cursor.after).getTime(),
                                ),
                            );
                    } else if (afterInclusive)
                        conds.push(gte(messagesSqlite.seq, afterSeq));
                    else conds.push(gt(messagesSqlite.seq, afterSeq));
                    const up =
                        forward ||
                        Boolean(newer) ||
                        Boolean(!older && cursor?.after);
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(and(...conds))
                        .orderBy(
                            up
                                ? asc(messagesSqlite.seq)
                                : desc(messagesSqlite.seq),
                            up
                                ? asc(messagesSqlite.createdAt)
                                : desc(messagesSqlite.createdAt),
                            up
                                ? asc(messagesSqlite.id)
                                : desc(messagesSqlite.id),
                        )
                        .limit(limit);
                    const list = rows.map(messageRowToChat);
                    return up ? list : list.reverse();
                },
                async lastSeq(session) {
                    const row = client
                        .prepare(
                            "SELECT coalesce(max(seq), 0) AS maxSeq FROM messages WHERE session = ?",
                        )
                        .get(session) as { maxSeq: number };
                    return Number(row?.maxSeq ?? 0);
                },
                async summaries({ userId, username, sessions }) {
                    if (sessions.length === 0) return [];
                    const placeholders = sessions.map(() => "?").join(", ");
                    const grouped = client
                        .prepare(
                            `SELECT m.session AS session,
                                    max(m.seq) AS lastSeq,
                                    coalesce(max(r.seq), 0) AS readSeq,
                                    sum(CASE WHEN m.seq > coalesce(r.seq, 0)
                                        AND m.sender <> ? THEN 1 ELSE 0 END) AS unread
                             FROM messages m
                             LEFT JOIN reads r
                               ON r.session = m.session AND r.user_id = ?
                             WHERE m.session IN (${placeholders})
                             GROUP BY m.session`,
                        )
                        .all(username, userId, ...sessions) as Array<{
                        session: string;
                        lastSeq: number;
                        readSeq: number;
                        unread: number;
                    }>;
                    const stats = new Map(
                        grouped.map((row) => [
                            row.session,
                            {
                                lastSeq: Number(row.lastSeq ?? 0),
                                readSeq: Number(row.readSeq ?? 0),
                                unread: Number(row.unread ?? 0),
                            },
                        ]),
                    );
                    const latestConds = sessions
                        .map((session) => ({ session, ...stats.get(session) }))
                        .filter(
                            (
                                entry,
                            ): entry is typeof entry & {
                                lastSeq: number;
                            } => (entry.lastSeq ?? 0) > 0,
                        )
                        .map((entry) =>
                            and(
                                eq(messagesSqlite.session, entry.session),
                                eq(messagesSqlite.seq, entry.lastSeq),
                            ),
                        );
                    const latest =
                        latestConds.length > 0
                            ? await db
                                  .select()
                                  .from(messagesSqlite)
                                  .where(
                                      latestConds.length === 1
                                          ? latestConds[0]
                                          : or(...latestConds),
                                  )
                            : [];
                    const lastBySession = new Map<string, ChatMessage>();
                    for (const row of latest)
                        lastBySession.set(row.session, messageRowToChat(row));
                    return sessions.map((session) => ({
                        session,
                        lastSeq: stats.get(session)?.lastSeq ?? 0,
                        readSeq: stats.get(session)?.readSeq ?? 0,
                        unread: stats.get(session)?.unread ?? 0,
                        lastMessage: lastBySession.get(session) ?? null,
                    }));
                },
                async since({ session, seq, limit }) {
                    const rows = await db
                        .select()
                        .from(messagesSqlite)
                        .where(
                            and(
                                eq(messagesSqlite.session, session),
                                gt(messagesSqlite.seq, seq),
                            ),
                        )
                        .orderBy(
                            asc(messagesSqlite.seq),
                            asc(messagesSqlite.createdAt),
                            asc(messagesSqlite.id),
                        )
                        .limit(limit);
                    return rows.map(messageRowToChat);
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
                async setReactions(id, reactions) {
                    const rows = await db
                        .update(messagesSqlite)
                        .set({ reactions: serializeReactions(reactions) })
                        .where(eq(messagesSqlite.id, id))
                        .returning();
                    const row = rows[0];
                    return row ? messageRowToChat(row) : null;
                },
                async edit(id, content, at) {
                    const rows = await db
                        .update(messagesSqlite)
                        .set({
                            content,
                            editedAt: new Date(at).getTime(),
                            editCount: sql`${messagesSqlite.editCount} + 1`,
                        })
                        .where(eq(messagesSqlite.id, id))
                        .returning();
                    const row = rows[0];
                    return row ? messageRowToChat(row) : null;
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
                    if (params.from) {
                        const from = Date.parse(params.from);
                        if (Number.isFinite(from))
                            conds.push(gte(messagesSqlite.createdAt, from));
                    }
                    if (params.to) {
                        const to = Date.parse(params.to);
                        if (Number.isFinite(to))
                            conds.push(lte(messagesSqlite.createdAt, to));
                    }
                    if (params.media)
                        conds.push(ne(messagesSqlite.kind, "text"));
                    if (params.keyword) {
                        const kw = params.keyword;
                        const useFts =
                            ftsEnabled &&
                            Array.from(kw).length >= 3 &&
                            !/\s/.test(kw);
                        if (useFts) {
                            conds.push(
                                sql`id IN (
                                    SELECT message_id FROM messages_fts
                                    WHERE messages_fts MATCH ${`"${kw.replace(/"/g, '""')}"`}
                                )`,
                            );
                        } else {
                            conds.push(likeKeyword(messagesSqlite.content, kw));
                        }
                    }
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
                            deptId: row.deptId,
                            title: row.title,
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
                async setOrg(id, deptId, title) {
                    await db
                        .update(usersSqlite)
                        .set({ deptId, title })
                        .where(eq(usersSqlite.id, id));
                },
                async setMustChange(id, on) {
                    await db
                        .update(usersSqlite)
                        .set({ mustChangePassword: on })
                        .where(eq(usersSqlite.id, id));
                },
                async totpOf(id) {
                    const rows = await db
                        .select({ secret: usersSqlite.totpSecret })
                        .from(usersSqlite)
                        .where(eq(usersSqlite.id, id))
                        .limit(1);
                    return rows[0]?.secret ?? null;
                },
                async setTotp(id, secret) {
                    await db
                        .update(usersSqlite)
                        .set({ totpSecret: secret })
                        .where(eq(usersSqlite.id, id));
                },
                async count() {
                    const rows = await db
                        .select({ id: usersSqlite.id })
                        .from(usersSqlite);
                    return rows.length;
                },
            };

            departments = {
                async create(name, parentId) {
                    const id = crypto.randomUUID();
                    const siblings = await db
                        .select({ sort: departmentsSqlite.sort })
                        .from(departmentsSqlite)
                        .where(
                            parentId === null
                                ? isNull(departmentsSqlite.parentId)
                                : eq(departmentsSqlite.parentId, parentId),
                        );
                    const sort =
                        siblings.reduce(
                            (max, row) => Math.max(max, row.sort),
                            0,
                        ) + 1;
                    const now = Date.now();
                    await db.insert(departmentsSqlite).values({
                        id,
                        name,
                        parentId,
                        sort,
                        createdAt: now,
                    });
                    return {
                        id,
                        name,
                        parentId,
                        sort,
                        groupId: null,
                        createdAt: new Date(now).toISOString(),
                    };
                },
                async byId(id) {
                    const rows = await db
                        .select()
                        .from(departmentsSqlite)
                        .where(eq(departmentsSqlite.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row
                        ? {
                              id: row.id,
                              name: row.name,
                              parentId: row.parentId,
                              sort: row.sort,
                              groupId: row.groupId,
                              createdAt: toIso(row.createdAt),
                          }
                        : null;
                },
                async listAll() {
                    const rows = await db
                        .select()
                        .from(departmentsSqlite)
                        .orderBy(
                            asc(departmentsSqlite.sort),
                            asc(departmentsSqlite.createdAt),
                        );
                    return rows.map(
                        (row): DepartmentRow => ({
                            id: row.id,
                            name: row.name,
                            parentId: row.parentId,
                            sort: row.sort,
                            groupId: row.groupId,
                            createdAt: toIso(row.createdAt),
                        }),
                    );
                },
                async rename(id, name) {
                    await db
                        .update(departmentsSqlite)
                        .set({ name })
                        .where(eq(departmentsSqlite.id, id));
                },
                async move(id, parentId) {
                    await db
                        .update(departmentsSqlite)
                        .set({ parentId })
                        .where(eq(departmentsSqlite.id, id));
                },
                async remove(id) {
                    await db
                        .delete(departmentsSqlite)
                        .where(eq(departmentsSqlite.id, id));
                },
                async setGroup(id, groupId) {
                    await db
                        .update(departmentsSqlite)
                        .set({ groupId })
                        .where(eq(departmentsSqlite.id, id));
                },
                async memberCounts() {
                    const rows = await db
                        .select({ deptId: usersSqlite.deptId })
                        .from(usersSqlite);
                    const counts: Record<string, number> = {};
                    for (const row of rows) {
                        if (!row.deptId) continue;
                        counts[row.deptId] = (counts[row.deptId] ?? 0) + 1;
                    }
                    return counts;
                },
            };

            audits = {
                async add(row) {
                    await db.insert(auditsSqlite).values({
                        id: crypto.randomUUID(),
                        actorId: row.actorId,
                        actor: row.actor,
                        action: row.action,
                        detail: row.detail,
                        createdAt: Date.now(),
                    });
                },
                async list(query) {
                    const conds = [];
                    const keyword = query.keyword?.trim();
                    if (keyword) {
                        const like = `%${keyword}%`;
                        conds.push(
                            sql`(${auditsSqlite.actor} LIKE ${like} OR ${auditsSqlite.detail} LIKE ${like})`,
                        );
                    }
                    if (query.category)
                        conds.push(
                            sql`${auditsSqlite.action} LIKE ${`${query.category}.%`}`,
                        );
                    const where = conds.length ? and(...conds) : undefined;
                    const countRows = await db
                        .select({ count: sql<number>`count(*)` })
                        .from(auditsSqlite)
                        .where(where);
                    const rows = await db
                        .select()
                        .from(auditsSqlite)
                        .where(where)
                        .orderBy(desc(auditsSqlite.createdAt))
                        .limit(query.limit)
                        .offset(query.offset);
                    return {
                        total: Number(countRows[0]?.count ?? 0),
                        rows: rows.map(
                            (row): AuditRow => ({
                                id: row.id,
                                actorId: row.actorId,
                                actor: row.actor,
                                action: row.action,
                                detail: row.detail,
                                createdAt: toIso(row.createdAt),
                            }),
                        ),
                    };
                },
            };

            authSessions = {
                async create(input) {
                    const now = Date.now();
                    await db.insert(authSessionsSqlite).values({
                        id: input.id,
                        userId: input.userId,
                        label: input.label,
                        userAgent: input.userAgent,
                        ip: input.ip,
                        createdAt: now,
                        lastSeenAt: now,
                    });
                    const iso = new Date(now).toISOString();
                    return {
                        id: input.id,
                        label: input.label,
                        userAgent: input.userAgent,
                        ip: input.ip,
                        createdAt: iso,
                        lastSeenAt: iso,
                        revoked: false,
                    };
                },
                async touch(id) {
                    await db
                        .update(authSessionsSqlite)
                        .set({ lastSeenAt: Date.now() })
                        .where(
                            and(
                                eq(authSessionsSqlite.id, id),
                                isNull(authSessionsSqlite.revokedAt),
                            ),
                        );
                },
                async list(userId) {
                    const rows = await db
                        .select()
                        .from(authSessionsSqlite)
                        .where(eq(authSessionsSqlite.userId, userId))
                        .orderBy(desc(authSessionsSqlite.lastSeenAt))
                        .limit(50);
                    return rows.map(authDeviceOf);
                },
                async rename(userId, id, label) {
                    const rows = await db
                        .update(authSessionsSqlite)
                        .set({ label })
                        .where(
                            and(
                                eq(authSessionsSqlite.id, id),
                                eq(authSessionsSqlite.userId, userId),
                            ),
                        )
                        .returning();
                    return rows.length > 0;
                },
                async revoke(userId, id) {
                    const rows = await db
                        .update(authSessionsSqlite)
                        .set({ revokedAt: Date.now() })
                        .where(
                            and(
                                eq(authSessionsSqlite.id, id),
                                eq(authSessionsSqlite.userId, userId),
                                isNull(authSessionsSqlite.revokedAt),
                            ),
                        )
                        .returning();
                    return rows.length > 0;
                },
                async revokeOthers(userId, keepId) {
                    const rows = await db
                        .update(authSessionsSqlite)
                        .set({ revokedAt: Date.now() })
                        .where(
                            and(
                                eq(authSessionsSqlite.userId, userId),
                                ne(authSessionsSqlite.id, keepId),
                                isNull(authSessionsSqlite.revokedAt),
                            ),
                        )
                        .returning();
                    return rows.length;
                },
                async isActive(userId, id) {
                    const rows = await db
                        .select({ id: authSessionsSqlite.id })
                        .from(authSessionsSqlite)
                        .where(
                            and(
                                eq(authSessionsSqlite.id, id),
                                eq(authSessionsSqlite.userId, userId),
                                isNull(authSessionsSqlite.revokedAt),
                            ),
                        )
                        .limit(1);
                    return rows.length > 0;
                },
            };

            bots = {
                async createApp(input) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    await db.insert(botAppsSqlite).values({
                        id,
                        ownerId: input.ownerId,
                        name: input.name,
                        tokenHash: input.tokenHash,
                        scopes: serializeScopes(input.scopes),
                        createdAt: now,
                    });
                    const owner = await accounts.byId(input.ownerId);
                    return {
                        id,
                        ownerId: input.ownerId,
                        owner: owner?.username ?? "",
                        name: input.name,
                        tokenHash: input.tokenHash,
                        scopes: input.scopes,
                        createdAt: new Date(now).toISOString(),
                        lastUsedAt: null,
                        revoked: false,
                    };
                },
                async listApps(ownerId) {
                    const rows = await db
                        .select()
                        .from(botAppsSqlite)
                        .where(eq(botAppsSqlite.ownerId, ownerId))
                        .orderBy(desc(botAppsSqlite.createdAt))
                        .limit(50);
                    const owner = await accounts.byId(ownerId);
                    return rows.map((row) =>
                        botAppOf(row, owner?.username ?? ""),
                    );
                },
                async revokeApp(ownerId, id) {
                    const rows = await db
                        .update(botAppsSqlite)
                        .set({ revokedAt: Date.now() })
                        .where(
                            and(
                                eq(botAppsSqlite.id, id),
                                eq(botAppsSqlite.ownerId, ownerId),
                                isNull(botAppsSqlite.revokedAt),
                            ),
                        )
                        .returning();
                    return rows.length > 0;
                },
                async byToken(tokenHash) {
                    const rows = await db
                        .select()
                        .from(botAppsSqlite)
                        .where(
                            and(
                                eq(botAppsSqlite.tokenHash, tokenHash),
                                isNull(botAppsSqlite.revokedAt),
                            ),
                        )
                        .limit(1);
                    const row = rows[0];
                    if (!row) return null;
                    const owner = await accounts.byId(row.ownerId);
                    await db
                        .update(botAppsSqlite)
                        .set({ lastUsedAt: Date.now() })
                        .where(eq(botAppsSqlite.id, row.id));
                    return botAppOf(row, owner?.username ?? "");
                },
                async createHook(input) {
                    const id = crypto.randomUUID();
                    const now = Date.now();
                    await db.insert(botHooksSqlite).values({
                        id,
                        botId: input.botId,
                        url: input.url,
                        secret: input.secret,
                        events: JSON.stringify(input.events),
                        enabled: true,
                        createdAt: now,
                    });
                    const bot = await db
                        .select({ name: botAppsSqlite.name })
                        .from(botAppsSqlite)
                        .where(eq(botAppsSqlite.id, input.botId))
                        .limit(1);
                    return {
                        id,
                        botId: input.botId,
                        botName: bot[0]?.name ?? "",
                        url: input.url,
                        secret: input.secret,
                        events: input.events,
                        enabled: true,
                        failures: 0,
                        lastError: null,
                        createdAt: new Date(now).toISOString(),
                    };
                },
                async listHooks(ownerId) {
                    const rows = await db
                        .select({
                            hook: botHooksSqlite,
                            name: botAppsSqlite.name,
                        })
                        .from(botHooksSqlite)
                        .innerJoin(
                            botAppsSqlite,
                            eq(botAppsSqlite.id, botHooksSqlite.botId),
                        )
                        .where(eq(botAppsSqlite.ownerId, ownerId))
                        .orderBy(desc(botHooksSqlite.createdAt))
                        .limit(100);
                    return rows.map((row) =>
                        botHookOf(row.hook, row.name ?? ""),
                    );
                },
                async setHookEnabled(ownerId, id, enabled) {
                    const owned = await db
                        .select({ id: botHooksSqlite.id })
                        .from(botHooksSqlite)
                        .innerJoin(
                            botAppsSqlite,
                            eq(botAppsSqlite.id, botHooksSqlite.botId),
                        )
                        .where(
                            and(
                                eq(botHooksSqlite.id, id),
                                eq(botAppsSqlite.ownerId, ownerId),
                            ),
                        )
                        .limit(1);
                    if (owned.length === 0) return false;
                    await db
                        .update(botHooksSqlite)
                        .set({ enabled, lastError: null })
                        .where(eq(botHooksSqlite.id, id));
                    return true;
                },
                async removeHook(ownerId, id) {
                    const owned = await db
                        .select({ id: botHooksSqlite.id })
                        .from(botHooksSqlite)
                        .innerJoin(
                            botAppsSqlite,
                            eq(botAppsSqlite.id, botHooksSqlite.botId),
                        )
                        .where(
                            and(
                                eq(botHooksSqlite.id, id),
                                eq(botAppsSqlite.ownerId, ownerId),
                            ),
                        )
                        .limit(1);
                    if (owned.length === 0) return false;
                    await db
                        .delete(botHooksSqlite)
                        .where(eq(botHooksSqlite.id, id));
                    return true;
                },
                async hooksOfEvent(event) {
                    const rows = await db
                        .select({
                            hook: botHooksSqlite,
                            name: botAppsSqlite.name,
                        })
                        .from(botHooksSqlite)
                        .innerJoin(
                            botAppsSqlite,
                            eq(botAppsSqlite.id, botHooksSqlite.botId),
                        )
                        .where(
                            and(
                                eq(botHooksSqlite.enabled, true),
                                isNull(botAppsSqlite.revokedAt),
                            ),
                        )
                        .limit(500);
                    return rows
                        .filter((row) =>
                            parseIdList(row.hook.events).includes(event),
                        )
                        .map((row) => botHookOf(row.hook, row.name ?? ""));
                },
                async reportHook(id, ok, error) {
                    await db
                        .update(botHooksSqlite)
                        .set({
                            failures: ok
                                ? 0
                                : sql`${botHooksSqlite.failures} + 1`,
                            lastError: error,
                        })
                        .where(eq(botHooksSqlite.id, id));
                },
            };

            friends = {
                async request(requesterId, addresseeId, message) {
                    await db
                        .insert(friendshipsSqlite)
                        .values({
                            requesterId,
                            addresseeId,
                            status: "pending",
                            createdAt: Date.now(),
                            message: message ?? null,
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
                async starsOf(ownerId) {
                    const rows = await db
                        .select({ friendId: friendStarsSqlite.friendId })
                        .from(friendStarsSqlite)
                        .where(eq(friendStarsSqlite.ownerId, ownerId));
                    return rows.map((row) => row.friendId);
                },
                async setStar(ownerId, friendId, on) {
                    if (!on) {
                        await db
                            .delete(friendStarsSqlite)
                            .where(
                                and(
                                    eq(friendStarsSqlite.ownerId, ownerId),
                                    eq(friendStarsSqlite.friendId, friendId),
                                ),
                            );
                        return;
                    }
                    await db
                        .insert(friendStarsSqlite)
                        .values({ ownerId, friendId })
                        .onConflictDoNothing();
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
                async setOwner(id, ownerId) {
                    await db
                        .update(groupsSqlite)
                        .set({ ownerId })
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
                async setMemberTitle(groupId, userId, title) {
                    await db
                        .update(groupMembersSqlite)
                        .set({ title })
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
                            title: row.title,
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
                async set(userId, session, at, seq) {
                    await db
                        .insert(readsSqlite)
                        .values({
                            userId,
                            session,
                            readAt: Date.parse(at),
                            seq: seq ?? 0,
                        })
                        .onConflictDoUpdate({
                            target: [readsSqlite.userId, readsSqlite.session],
                            set: {
                                readAt: Date.parse(at),
                                seq: sql`max(${readsSqlite.seq}, ${seq ?? 0})`,
                            },
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
                        seq: row.seq,
                    }));
                },
                async cursorsOf(userId) {
                    const rows = await db
                        .select()
                        .from(readsSqlite)
                        .where(eq(readsSqlite.userId, userId));
                    return Object.fromEntries(
                        rows.map((row) => [row.session, row.seq]),
                    );
                },
            };

            sessionMeta = {
                async of(userId) {
                    const rows = await db
                        .select()
                        .from(sessionMetaSqlite)
                        .where(eq(sessionMetaSqlite.userId, userId));
                    return rows.map((row) => ({
                        session: row.session,
                        pinned: row.pinned,
                    }));
                },
                async ofSession(userId, session) {
                    const rows = await db
                        .select()
                        .from(sessionMetaSqlite)
                        .where(
                            and(
                                eq(sessionMetaSqlite.userId, userId),
                                eq(sessionMetaSqlite.session, session),
                            ),
                        )
                        .limit(1);
                    const row = rows[0];
                    return row
                        ? {
                              session: row.session,
                              pinned: row.pinned,
                          }
                        : null;
                },
                async set(userId, session, patch) {
                    const rows = await db
                        .insert(sessionMetaSqlite)
                        .values({
                            userId,
                            session,
                            pinned: patch.pinned ?? false,
                        })
                        .onConflictDoUpdate({
                            target: [
                                sessionMetaSqlite.userId,
                                sessionMetaSqlite.session,
                            ],
                            set: {
                                ...(patch.pinned === undefined
                                    ? {}
                                    : { pinned: patch.pinned }),
                            },
                        })
                        .returning();
                    const row = rows[0];
                    return {
                        session: row.session,
                        pinned: row.pinned,
                    };
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
                async remove(userId: string, endpoint: string) {
                    await db
                        .delete(pushSqlite)
                        .where(
                            and(
                                eq(pushSqlite.endpoint, endpoint),
                                eq(pushSqlite.userId, userId),
                            ),
                        );
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
                async commentById(id) {
                    const rows = await db
                        .select()
                        .from(momentCommentsSqlite)
                        .where(eq(momentCommentsSqlite.id, id))
                        .limit(1);
                    return rows[0] ? momentCommentToRow(rows[0]) : null;
                },
                async removeComment(id) {
                    await db
                        .delete(momentCommentsSqlite)
                        .where(eq(momentCommentsSqlite.id, id));
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

            redPackets = {
                async create(input) {
                    await db.insert(redPacketsSqlite).values({
                        id: input.id,
                        sessionId: input.sessionId,
                        senderId: input.senderId,
                        type: input.type,
                        totalAmount: input.totalAmount,
                        totalCount: input.totalCount,
                        remaining: input.totalAmount,
                        remainCount: input.totalCount,
                        status: "active",
                        message: input.message ?? null,
                        createdAt: new Date(input.createdAt).getTime(),
                        expiredAt: input.expiredAt
                            ? new Date(input.expiredAt).getTime()
                            : null,
                    });
                },
                async getById(id) {
                    const rows = await db
                        .select()
                        .from(redPacketsSqlite)
                        .where(eq(redPacketsSqlite.id, id))
                        .limit(1);
                    const row = rows[0];
                    return row
                        ? {
                              id: row.id,
                              sessionId: row.sessionId,
                              senderId: row.senderId,
                              type: row.type as "normal" | "lucky",
                              totalAmount: row.totalAmount,
                              totalCount: row.totalCount,
                              remaining: row.remaining,
                              remainCount: row.remainCount,
                              status: row.status as RedPacketRow["status"],
                              message: row.message,
                              createdAt: new Date(row.createdAt).toISOString(),
                              expiredAt:
                                  row.expiredAt === null
                                      ? null
                                      : new Date(row.expiredAt).toISOString(),
                          }
                        : null;
                },
                async claimedBy(redPacketId, claimerId) {
                    const rows = await db
                        .select({ amount: redPacketRecordsSqlite.amount })
                        .from(redPacketRecordsSqlite)
                        .where(
                            and(
                                eq(
                                    redPacketRecordsSqlite.redPacketId,
                                    redPacketId,
                                ),
                                eq(redPacketRecordsSqlite.claimerId, claimerId),
                            ),
                        )
                        .limit(1);
                    return rows[0] ? rows[0].amount : null;
                },
                async listRecords(redPacketId) {
                    const rows = await db
                        .select()
                        .from(redPacketRecordsSqlite)
                        .where(
                            eq(redPacketRecordsSqlite.redPacketId, redPacketId),
                        )
                        .orderBy(asc(redPacketRecordsSqlite.claimedAt));
                    return rows.map((row) => ({
                        id: row.id,
                        redPacketId: row.redPacketId,
                        claimerId: row.claimerId,
                        amount: row.amount,
                        claimedAt: new Date(row.claimedAt).toISOString(),
                    }));
                },
                async listSession(sessionId) {
                    const rows = await db
                        .select()
                        .from(redPacketsSqlite)
                        .where(eq(redPacketsSqlite.sessionId, sessionId))
                        .orderBy(desc(redPacketsSqlite.createdAt))
                        .limit(100);
                    return rows.map((row) => ({
                        id: row.id,
                        sessionId: row.sessionId,
                        senderId: row.senderId,
                        type: row.type as "normal" | "lucky",
                        totalAmount: row.totalAmount,
                        totalCount: row.totalCount,
                        remaining: row.remaining,
                        remainCount: row.remainCount,
                        status: row.status as RedPacketRow["status"],
                        message: row.message,
                        createdAt: new Date(row.createdAt).toISOString(),
                        expiredAt:
                            row.expiredAt === null
                                ? null
                                : new Date(row.expiredAt).toISOString(),
                    }));
                },
                async claim(input) {
                    return db.transaction((tx): RedPacketClaimResult => {
                        const packet = tx
                            .select()
                            .from(redPacketsSqlite)
                            .where(eq(redPacketsSqlite.id, input.redPacketId))
                            .get() as
                            | typeof redPacketsSqlite.$inferSelect
                            | undefined;
                        if (!packet)
                            return {
                                ok: false as const,
                                reason: "missing" as const,
                            };
                        const dup = tx
                            .select({ id: redPacketRecordsSqlite.id })
                            .from(redPacketRecordsSqlite)
                            .where(
                                and(
                                    eq(
                                        redPacketRecordsSqlite.redPacketId,
                                        input.redPacketId,
                                    ),
                                    eq(
                                        redPacketRecordsSqlite.claimerId,
                                        input.claimerId,
                                    ),
                                ),
                            )
                            .get();
                        if (dup)
                            return {
                                ok: false as const,
                                reason: "duplicate" as const,
                            };
                        if (
                            packet.status !== "active" ||
                            packet.remainCount <= 0
                        )
                            return {
                                ok: false as const,
                                reason: "empty" as const,
                            };
                        if (packet.remaining < input.amount)
                            return {
                                ok: false as const,
                                reason: "empty" as const,
                            };
                        tx.insert(redPacketRecordsSqlite)
                            .values({
                                id: input.recordId,
                                redPacketId: input.redPacketId,
                                claimerId: input.claimerId,
                                amount: input.amount,
                                claimedAt: new Date(input.claimedAt).getTime(),
                            })
                            .run();
                        const remainCount = packet.remainCount - 1;
                        const remaining = packet.remaining - input.amount;
                        const exhausted = remainCount <= 0 || remaining <= 0;
                        tx.update(redPacketsSqlite)
                            .set({
                                remainCount,
                                remaining,
                                status: exhausted ? "exhausted" : packet.status,
                            })
                            .where(eq(redPacketsSqlite.id, input.redPacketId))
                            .run();
                        return {
                            ok: true as const,
                            packet: {
                                id: packet.id,
                                sessionId: packet.sessionId,
                                senderId: packet.senderId,
                                type: packet.type as "normal" | "lucky",
                                totalAmount: packet.totalAmount,
                                totalCount: packet.totalCount,
                                remaining,
                                remainCount,
                                status: (exhausted
                                    ? "exhausted"
                                    : packet.status) as RedPacketRow["status"],
                                message: packet.message,
                                createdAt: new Date(
                                    packet.createdAt,
                                ).toISOString(),
                                expiredAt:
                                    packet.expiredAt === null
                                        ? null
                                        : new Date(
                                              packet.expiredAt,
                                          ).toISOString(),
                            },
                        };
                    });
                },
                async expireIfNeeded(now) {
                    const at = new Date(now).getTime();
                    const rows = await db
                        .select({ id: redPacketsSqlite.id })
                        .from(redPacketsSqlite)
                        .where(
                            and(
                                eq(redPacketsSqlite.status, "active"),
                                lte(redPacketsSqlite.expiredAt, at),
                            ),
                        );
                    if (rows.length === 0) return [];
                    await db
                        .update(redPacketsSqlite)
                        .set({ status: "expired" })
                        .where(
                            inArray(
                                redPacketsSqlite.id,
                                rows.map((row) => row.id),
                            ),
                        );
                    return rows.map((row) => row.id);
                },
                async claimBack(redPacketId, input) {
                    const rows = await db
                        .select({
                            remaining: redPacketsSqlite.remaining,
                            remainCount: redPacketsSqlite.remainCount,
                            status: redPacketsSqlite.status,
                            claimedAt: redPacketRecordsSqlite.claimedAt,
                        })
                        .from(redPacketsSqlite)
                        .leftJoin(
                            redPacketRecordsSqlite,
                            eq(redPacketRecordsSqlite.redPacketId, redPacketId),
                        )
                        .where(eq(redPacketsSqlite.id, redPacketId))
                        .limit(1);
                    const row = rows[0];
                    if (!row) return { ...EMPTY_CLAIM_BACK };
                    const claimedCount = rows.length;
                    if (row.status !== "active")
                        return {
                            status: row.status as RedPacketRow["status"],
                            remaining: row.remaining,
                            remainCount: row.remainCount,
                            claimedCount,
                        };
                    const latest = new Date(
                        rows[claimedCount - 1]?.claimedAt ?? input.at,
                    ).getTime();
                    if (latest > new Date(input.at).getTime())
                        return {
                            status: row.status as RedPacketRow["status"],
                            remaining: row.remaining,
                            remainCount: row.remainCount,
                            claimedCount,
                        };
                    await db
                        .update(redPacketsSqlite)
                        .set({ status: "expired" })
                        .where(eq(redPacketsSqlite.id, redPacketId));
                    return {
                        status: "expired" as const,
                        remaining: row.remaining,
                        remainCount: row.remainCount,
                        claimedCount,
                    };
                },
            };

            const sqTransferRowOf = (
                row: typeof transfersSqlite.$inferSelect,
            ): TransferRow => ({
                id: row.id,
                sessionId: row.session,
                fromId: row.fromId,
                toId: row.toId,
                amount: row.amount,
                message: row.message,
                state: row.state as TransferState,
                createdAt: new Date(row.createdAt).toISOString(),
                expiredAt: new Date(row.expiredAt).toISOString(),
            });

            const sqBillRowOf = (
                row: typeof aaBillsSqlite.$inferSelect,
            ): AABillRow => ({
                id: row.id,
                sessionId: row.session,
                creatorId: row.creatorId,
                description: row.description,
                totalAmount: row.totalAmount,
                settledAmount: row.settledAmount,
                participantIds: parseIdList(row.participantIds),
                splitType: row.splitType as AABillRow["splitType"],
                customSplits: parseSplitMap(row.customSplits),
                status: row.status as AABillRow["status"],
                createdAt: new Date(row.createdAt).toISOString(),
                deadline: new Date(row.deadline).toISOString(),
            });

            const sqPaymentRowOf = (
                row: typeof aaPaymentsSqlite.$inferSelect,
            ): AAPaymentRow => ({
                id: row.id,
                billId: row.billId,
                payerId: row.payerId,
                amount: row.amount,
                paidAt: new Date(row.paidAt).toISOString(),
            });

            const sqAddBalance = (
                tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
                userId: string,
                delta: number,
            ): void => {
                if (delta === 0) return;
                tx.update(usersSqlite)
                    .set({ balance: sql`${usersSqlite.balance} + ${delta}` })
                    .where(eq(usersSqlite.id, userId))
                    .run();
            };

            const sqBalanceRow = (
                tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
                userId: string,
            ): number | null => {
                const row = tx
                    .select({ balance: usersSqlite.balance })
                    .from(usersSqlite)
                    .where(eq(usersSqlite.id, userId))
                    .limit(1)
                    .get() as { balance: number } | undefined;
                return row ? row.balance : null;
            };

            wallet = {
                async balanceOf(userId) {
                    const rows = await db
                        .select({ balance: usersSqlite.balance })
                        .from(usersSqlite)
                        .where(eq(usersSqlite.id, userId))
                        .limit(1);
                    return rows[0]?.balance ?? 0;
                },
                async balancesOf(userIds) {
                    if (userIds.length === 0) return {};
                    const rows = await db
                        .select({
                            id: usersSqlite.id,
                            balance: usersSqlite.balance,
                        })
                        .from(usersSqlite)
                        .where(inArray(usersSqlite.id, userIds));
                    return Object.fromEntries(
                        rows.map((row) => [row.id, row.balance]),
                    );
                },
                async adjustBalance(userId, delta) {
                    return db.transaction((tx) => {
                        const current = sqBalanceRow(tx, userId);
                        if (current === null) throw new Error("用户不存在");
                        const next = current + delta;
                        if (next < 0) throw new Error("余额不足");
                        tx.update(usersSqlite)
                            .set({ balance: next })
                            .where(eq(usersSqlite.id, userId))
                            .run();
                        return next;
                    });
                },
                async transferCreate(input) {
                    return db.transaction((tx): TransferCreateResult => {
                        const dup = tx
                            .select({ id: transfersSqlite.id })
                            .from(transfersSqlite)
                            .where(eq(transfersSqlite.id, input.id))
                            .limit(1)
                            .get();
                        if (dup)
                            return { ok: false as const, reason: "duplicate" };
                        const current = sqBalanceRow(tx, input.fromId);
                        if (current === null)
                            return { ok: false as const, reason: "missing" };
                        if (current < input.amount)
                            return {
                                ok: false as const,
                                reason: "insufficient",
                            };
                        sqAddBalance(tx, input.fromId, -input.amount);
                        tx.insert(transfersSqlite)
                            .values({
                                id: input.id,
                                session: input.sessionId,
                                fromId: input.fromId,
                                toId: input.toId,
                                amount: input.amount,
                                message: input.message ?? null,
                                state: "pending",
                                createdAt: new Date(input.createdAt).getTime(),
                                expiredAt: new Date(input.expiredAt).getTime(),
                            })
                            .run();
                        const row = tx
                            .select()
                            .from(transfersSqlite)
                            .where(eq(transfersSqlite.id, input.id))
                            .get() as typeof transfersSqlite.$inferSelect;
                        return {
                            ok: true as const,
                            transfer: sqTransferRowOf(row),
                        };
                    });
                },
                async transferGet(id) {
                    const row = await db
                        .select()
                        .from(transfersSqlite)
                        .where(eq(transfersSqlite.id, id))
                        .limit(1);
                    return row[0] ? sqTransferRowOf(row[0]) : null;
                },
                async transferSettle(id, action) {
                    return db.transaction((tx): TransferSettleResult => {
                        const row = tx
                            .select()
                            .from(transfersSqlite)
                            .where(eq(transfersSqlite.id, id))
                            .limit(1)
                            .get() as
                            | typeof transfersSqlite.$inferSelect
                            | undefined;
                        if (!row)
                            return { ok: false as const, reason: "missing" };
                        if (row.state !== "pending")
                            return { ok: false as const, reason: "conflict" };
                        const next: TransferState =
                            action === "accept" ? "accepted" : "rejected";
                        if (action === "accept")
                            sqAddBalance(tx, row.toId, row.amount);
                        else sqAddBalance(tx, row.fromId, row.amount);
                        tx.update(transfersSqlite)
                            .set({ state: next })
                            .where(eq(transfersSqlite.id, id))
                            .run();
                        return {
                            ok: true as const,
                            transfer: sqTransferRowOf({ ...row, state: next }),
                        };
                    });
                },
                async transferExpireIfNeeded() {
                    const now = Date.now();
                    const rows = await db
                        .select()
                        .from(transfersSqlite)
                        .where(
                            and(
                                eq(transfersSqlite.state, "pending"),
                                lte(transfersSqlite.expiredAt, now),
                            ),
                        );
                    if (rows.length === 0) return [];
                    db.transaction((tx) => {
                        for (const row of rows) {
                            sqAddBalance(tx, row.fromId, row.amount);
                            tx.update(transfersSqlite)
                                .set({ state: "refunded" })
                                .where(eq(transfersSqlite.id, row.id))
                                .run();
                        }
                    });
                    return rows.map((row) => row.id);
                },
                async transferListForUser(userId) {
                    const rows = await db
                        .select()
                        .from(transfersSqlite)
                        .where(
                            or(
                                eq(transfersSqlite.fromId, userId),
                                eq(transfersSqlite.toId, userId),
                            ),
                        )
                        .orderBy(desc(transfersSqlite.createdAt))
                        .limit(200);
                    return rows.map(sqTransferRowOf);
                },
                async transferListSession(sessionId) {
                    const rows = await db
                        .select()
                        .from(transfersSqlite)
                        .where(eq(transfersSqlite.session, sessionId))
                        .orderBy(desc(transfersSqlite.createdAt))
                        .limit(100);
                    return rows.map(sqTransferRowOf);
                },
                async aaCreate(input) {
                    await db.insert(aaBillsSqlite).values({
                        id: input.id,
                        session: input.sessionId,
                        creatorId: input.creatorId,
                        description: input.description,
                        totalAmount: input.totalAmount,
                        settledAmount: 0,
                        participantIds: JSON.stringify(input.participantIds),
                        splitType: input.splitType,
                        customSplits: JSON.stringify(input.customSplits),
                        status: "pending",
                        createdAt: new Date(input.createdAt).getTime(),
                        deadline: new Date(input.deadline).getTime(),
                    });
                },
                async aaGetById(id) {
                    const row = await db
                        .select()
                        .from(aaBillsSqlite)
                        .where(eq(aaBillsSqlite.id, id))
                        .limit(1);
                    return row[0] ? sqBillRowOf(row[0]) : null;
                },
                async aaListSession(sessionId) {
                    const rows = await db
                        .select()
                        .from(aaBillsSqlite)
                        .where(eq(aaBillsSqlite.session, sessionId))
                        .orderBy(desc(aaBillsSqlite.createdAt))
                        .limit(100);
                    return rows.map(sqBillRowOf);
                },
                async aaListForUser(userId) {
                    const rows = await db
                        .select()
                        .from(aaBillsSqlite)
                        .where(
                            or(
                                eq(aaBillsSqlite.creatorId, userId),
                                sql`${aaBillsSqlite.participantIds} LIKE ${`%${userId}%`}`,
                            ),
                        )
                        .orderBy(desc(aaBillsSqlite.createdAt))
                        .limit(200);
                    return rows
                        .map(sqBillRowOf)
                        .filter(
                            (bill) =>
                                bill.creatorId === userId ||
                                bill.participantIds.includes(userId),
                        );
                },
                async aaPayments(billId) {
                    const rows = await db
                        .select()
                        .from(aaPaymentsSqlite)
                        .where(eq(aaPaymentsSqlite.billId, billId))
                        .orderBy(asc(aaPaymentsSqlite.paidAt));
                    return rows.map(sqPaymentRowOf);
                },
                async aaPay(input) {
                    return db.transaction((tx): AAPayResult => {
                        const bill = tx
                            .select()
                            .from(aaBillsSqlite)
                            .where(eq(aaBillsSqlite.id, input.billId))
                            .get() as
                            | typeof aaBillsSqlite.$inferSelect
                            | undefined;
                        if (!bill)
                            return { ok: false as const, reason: "missing" };
                        if (bill.status !== "pending")
                            return { ok: false as const, reason: "closed" };
                        const dup = tx
                            .select({ id: aaPaymentsSqlite.id })
                            .from(aaPaymentsSqlite)
                            .where(
                                and(
                                    eq(aaPaymentsSqlite.billId, input.billId),
                                    eq(aaPaymentsSqlite.payerId, input.payerId),
                                ),
                            )
                            .get();
                        if (dup)
                            return { ok: false as const, reason: "duplicate" };
                        const shares = splitOf(
                            sqBillRowOf(bill),
                            input.payerId,
                        );
                        if (shares === null || shares !== input.amount)
                            return { ok: false as const, reason: "amount" };
                        const current = sqBalanceRow(tx, input.payerId);
                        if (current === null)
                            return { ok: false as const, reason: "missing" };
                        if (current < input.amount)
                            return {
                                ok: false as const,
                                reason: "insufficient",
                            };
                        sqAddBalance(tx, input.payerId, -input.amount);
                        sqAddBalance(tx, bill.creatorId, input.amount);
                        tx.insert(aaPaymentsSqlite)
                            .values({
                                id: input.paymentId,
                                billId: input.billId,
                                payerId: input.payerId,
                                amount: input.amount,
                                paidAt: new Date(input.paidAt).getTime(),
                            })
                            .run();
                        const settledAmount = bill.settledAmount + input.amount;
                        const done = settledAmount >= bill.totalAmount;
                        const status = done ? "settled" : "pending";
                        tx.update(aaBillsSqlite)
                            .set({ settledAmount, status })
                            .where(eq(aaBillsSqlite.id, input.billId))
                            .run();
                        const payment = tx
                            .select()
                            .from(aaPaymentsSqlite)
                            .where(
                                and(
                                    eq(aaPaymentsSqlite.billId, input.billId),
                                    eq(aaPaymentsSqlite.payerId, input.payerId),
                                ),
                            )
                            .get() as typeof aaPaymentsSqlite.$inferSelect;
                        return {
                            ok: true as const,
                            bill: sqBillRowOf({
                                ...bill,
                                settledAmount,
                                status,
                            }),
                            payment: sqPaymentRowOf(payment),
                        };
                    });
                },
                async aaCancel(id) {
                    const changed = await db
                        .update(aaBillsSqlite)
                        .set({ status: "cancelled" })
                        .where(
                            and(
                                eq(aaBillsSqlite.id, id),
                                eq(aaBillsSqlite.status, "pending"),
                            ),
                        )
                        .returning({ id: aaBillsSqlite.id });
                    return changed.length > 0;
                },
                async aaOverdue() {
                    const rows = await db
                        .select()
                        .from(aaBillsSqlite)
                        .where(
                            and(
                                eq(aaBillsSqlite.status, "pending"),
                                lt(aaBillsSqlite.deadline, Date.now()),
                            ),
                        )
                        .orderBy(desc(aaBillsSqlite.createdAt))
                        .limit(100);
                    return rows.map(sqBillRowOf);
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
        ctx.provide<SessionMetaStore>("sessionMeta", sessionMeta);
        ctx.provide<SettingsStore>("settings", settings);
        ctx.provide<PushStore>("pushes", pushes);
        ctx.provide<MediaFilesStore>("mediaFiles", mediaFiles);
        ctx.provide<GroupFilesStore>("groupFiles", groupFiles);
        ctx.provide<JoinRequestsStore>("join-requests", joinRequests);
        ctx.provide<MomentsStore>("moments", moments);
        ctx.provide<DepartmentsStore>("departments", departments);
        ctx.provide<AuditStore>("audits", audits);
        ctx.provide<RedPacketStore>("redPackets", redPackets);
        ctx.provide<WalletStore>("wallet", wallet);
        ctx.provide<AuthSessionsStore>("authSessions", authSessions);
        ctx.provide<BotsStore>("bots", bots);
        return undefined;
    },
};
