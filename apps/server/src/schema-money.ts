import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const redPackets = sqliteTable("red_packets", {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    type: text("type", { enum: ["normal", "lucky"] }).notNull(),
    totalAmount: integer("total_amount").notNull(),
    totalCount: integer("total_count").notNull(),
    remaining: integer("remaining").notNull(),
    remainCount: integer("remain_count").notNull(),
    status: text("status", {
        enum: ["active", "exhausted", "expired"],
    }).notNull(),
    message: text("message"),
    createdAt: text("created_at").notNull(),
    expiredAt: text("expired_at"),
});

export const redPacketRecords = sqliteTable("red_packet_records", {
    id: text("id").primaryKey(),
    redPacketId: text("red_packet_id").notNull(),
    claimerId: text("claimer_id").notNull(),
    amount: integer("amount").notNull(),
    claimedAt: text("claimed_at").notNull(),
});

export const aaBills = sqliteTable("aa_bills", {
    id: text("id").primaryKey(),
    creatorId: text("creator_id").notNull(),
    sessionId: text("session_id").notNull(),
    description: text("description").notNull(),
    totalAmount: integer("total_amount").notNull(),
    settledAmount: integer("settled_amount").notNull().default(0),
    participantIds: text("participant_ids").notNull(),
    splitType: text("split_type", { enum: ["equal", "custom"] }).notNull(),
    customSplits: text("custom_splits"),
    deadline: text("deadline").notNull(),
    status: text("status", {
        enum: ["pending", "settled", "cancelled"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
});

export const aaPayments = sqliteTable("aa_payments", {
    id: text("id").primaryKey(),
    billId: text("bill_id").notNull(),
    payerId: text("payer_id").notNull(),
    amount: integer("amount").notNull(),
    paidAt: text("paid_at").notNull(),
});

export const transfers = sqliteTable("transfers", {
    id: text("id").primaryKey(),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    amount: integer("amount").notNull(),
    message: text("message"),
    state: text("state", {
        enum: ["pending", "accepted", "rejected", "refunded"],
    }).notNull(),
    createdAt: text("created_at").notNull(),
    expiredAt: text("expired_at").notNull(),
});

export type InsertRedPacket = typeof redPackets.$inferInsert;
export type SelectRedPacket = typeof redPackets.$inferSelect;
export type InsertRedPacketRecord = typeof redPacketRecords.$inferInsert;
export type SelectRedPacketRecord = typeof redPacketRecords.$inferSelect;

export type InsertAABill = typeof aaBills.$inferInsert;
export type SelectAABill = typeof aaBills.$inferSelect;
export type InsertAAPayment = typeof aaPayments.$inferInsert;
export type SelectAAPayment = typeof aaPayments.$inferSelect;

export type InsertTransfer = typeof transfers.$inferInsert;
export type SelectTransfer = typeof transfers.$inferSelect;
