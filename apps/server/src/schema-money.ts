import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const redPackets = sqliteTable("red_packets", {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    senderId: text("sender_id").notNull(),
    type: text("type", { enum: ["normal", "lucky"] }).notNull(),
    totalAmount: integer("total_amount").notNull(),    
    totalCount: integer("total_count").notNull(),
    remaining: integer("remaining").notNull(),
    remainCount: integer("remain_count").notNull(),
    status: text("status", { enum: ["active", "exhausted", "expired"] }).notNull(),
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

// AA Bill Tables
export const aaBills = sqliteTable("aa_bills", {
    id: text("id").primaryKey(),
    creatorId: text("creator_id").notNull(),
    sessionId: text("session_id").notNull(),
    description: text("description").notNull(),
    totalAmount: integer("total_amount").notNull(),
    settledAmount: integer("settled_amount").notNull().default(0),
    participantIds: text("participant_ids").notNull(),   // JSON string
    splitType: text("split_type", { enum: ["equal", "custom"] }).notNull(),
    customSplits: text("custom_splits"),                 // JSON string (optional)
    deadline: text("deadline").notNull(),
    status: text("status", { enum: ["pending", "settled", "cancelled"] }).notNull(),
    createdAt: text("created_at").notNull(),
});

export const aaPayments = sqliteTable("aa_payments", {
    id: text("id").primaryKey(),
    billId: text("bill_id").notNull(),
    payerId: text("payer_id").notNull(),
    amount: integer("amount").notNull(),
    paidAt: text("paid_at").notNull(),
});

// Transfer Tables
export const transfers = sqliteTable("transfers", {
    id: text("id").primaryKey(),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
    amount: integer("amount").notNull(),
    message: text("message"),
    state: text("state", { enum: ["pending", "accepted", "rejected", "refunded"] }).notNull(),
    createdAt: text("created_at").notNull(),
    expiredAt: text("expired_at").notNull(),
});

export type InsertRedPacket = typeof redPackets.;
export type SelectRedPacket = typeof redPackets.;
export type InsertRedPacketRecord = typeof redPacketRecords.;
export type SelectRedPacketRecord = typeof redPacketRecords.;

export type InsertAABill = typeof aaBills.;
export type SelectAABill = typeof aaBills.;
export type InsertAAPayment = typeof aaPayments.;
export type SelectAAPayment = typeof aaPayments.;

export type InsertTransfer = typeof transfers.;
export type SelectTransfer = typeof transfers.;
