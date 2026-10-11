import type { RedPacketStore } from "../types";
import type { Database } from "better-sqlite3";

export function createRedPacketStore(db: Database): RedPacketStore {
    return {
        async create(input) {
            const stmt = db.prepare(`
                INSERT INTO red_packets 
                (id, sessionId, senderId, type, totalAmount, totalCount, remaining, remainCount, status, message, createdAt, expiredAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                input.id, input.sessionId, input.senderId, input.type,
                input.totalAmount, input.totalCount, input.totalAmount, input.totalCount,
                "active", input.message, input.createdAt, input.expiredAt || null
            );
        },

        async getById(id) {
            const stmt = db.prepare(`
                SELECT id, sessionId, senderId, type, totalAmount, totalCount, remaining, remainCount, status, message, createdAt, expiredAt
                FROM red_packets WHERE id = ?
            `);
            return stmt.get(id) as any || null;
        },

        async consumeById(id, amount) {
            const updateStmt = db.prepare(`
                UPDATE red_packets 
                SET remaining = remaining - ?, remainCount = remainCount - 1
                WHERE id = ? AND remaining >= ? AND remainCount > 0 AND status = active
            `);
            const res = updateStmt.run(id, amount, amount);
            if (res.changes > 0) {
                // Mark as exhausted when count reaches 0
                await this.markAsExhausted(id);
                return true;
            }
            return false;
        },

        async markAsExhausted(id) {
            const stmt = db.prepare(`
                UPDATE red_packets SET status = exhausted WHERE id = ? AND status = active
            `);
            stmt.run(id);
        },

        async expireIfNeeded() {
            const now = new Date().toISOString();
            const stmt = db.prepare(`
                UPDATE red_packets SET status = expired
                WHERE id IN (
                    SELECT id FROM red_packets WHERE expired_at IS NOT NULL AND expired_at < ?
                ) AND status = active
            `);
            stmt.run(now);
            return [];
        },

        async listRecords(redPacketId) {
            const stmt = db.prepare(`
                SELECT id, claimerId, amount, claimedAt
                FROM red_packet_records WHERE redPacketId = ?
            `);
            return stmt.all(redPacketId) as any[];
        },

        async countActive(sessionId: string, senderId: string) {
            const stmt = db.prepare(`
                SELECT COUNT(*) as count FROM red_packets 
                WHERE sessionId = ? AND senderId = ? AND status = active
            `);
            const row = stmt.get(sessionId, senderId) as { count: number };
            return row.count;
        },
    };
}
