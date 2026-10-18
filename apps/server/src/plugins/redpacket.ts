import type { Plugin } from "@plugim/core";
import type { RedPacketDetail } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ChatService,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupAclService,
    GroupsStore,
    RedPacketRow,
    RedPacketStore,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const MAX_TOTAL_AMOUNT = 200_000_000;
const MAX_COUNT = 200;
const MAX_MESSAGE = 50;
const DEFAULT_MESSAGE = "恭喜发财，大吉大利";
const TTL_MS = 24 * 60 * 60 * 1000;

const evenShare = (remaining: number, left: number): number => {
    const base = Math.floor(remaining / left);
    return remaining - base * (left - 1);
};

const luckyShare = (remaining: number, left: number): number => {
    if (left <= 1) return remaining;
    const min = 1;
    const max = Math.floor((remaining - min * (left - 1)) / left);
    if (max <= min) return min;
    return Math.min(max, min + Math.floor(Math.random() * (max - min + 1)));
};

const amountOf = (value: unknown, label: string): number => {
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num))
        throw new Error(`${label}必须是整数（单位：分）`);
    return num;
};

export const redpacketPlugin: Plugin = {
    name: "redpacket",
    description: "红包 RPC",
    provides: ["redpacket-rpc"],
    inject: [
        "gateway",
        "redPackets",
        "accounts",
        "friendships",
        "groups",
        "group-acl",
        "chat",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const redPackets = ctx.get<RedPacketStore>("redPackets");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");
        const acl = ctx.get<GroupAclService>("group-acl");
        const chat = ctx.get<ChatService>("chat");

        const participantIds = async (sessionId: string): Promise<string[]> => {
            const [, pair] = sessionId.split(":");
            const names = new Set((pair ?? "").split("|"));
            const all = await accounts.listAll();
            return all.filter((u) => names.has(u.username)).map((u) => u.id);
        };

        const audienceOf = async (
            user: AuthUser,
            row: RedPacketRow,
        ): Promise<string[]> => {
            if (row.sessionId.startsWith("p2p:"))
                return participantIds(row.sessionId);
            const groupId = row.sessionId.slice(2);
            try {
                await acl.requireMembership(groupId, user);
            } catch {
                return [];
            }
            return groups.memberIdsOf(groupId);
        };

        const canSeePacket = async (
            user: AuthUser,
            row: RedPacketRow,
        ): Promise<boolean> => {
            if (row.sessionId.startsWith("g:")) {
                try {
                    await acl.requireMembership(row.sessionId.slice(2), user);
                    return true;
                } catch {
                    return false;
                }
            }
            const [, pair] = row.sessionId.split(":");
            const names = (pair ?? "").split("|");
            return names.includes(user.username);
        };

        const resolveSession = async (
            user: AuthUser,
            rawSession: string,
        ): Promise<{ session: string; notifyUserIds: string[] }> => {
            if (rawSession.startsWith("p2p:")) {
                const peerName = rawSession.slice(4).trim();
                const peer = await accounts.byUsername(peerName.toLowerCase());
                if (!peer) throw new Error("对方不存在");
                if (peer.id === user.id) throw new Error("不能给自己发红包");
                return {
                    session: rawSession,
                    notifyUserIds: [user.id, peer.id],
                };
            }
            if (rawSession.startsWith("g:")) {
                const groupId = rawSession.slice(2);
                const { row } = await acl.requireMembership(groupId, user);
                return {
                    session: rawSession,
                    notifyUserIds: await groups.memberIdsOf(row.id),
                };
            }
            throw new Error("红包只能在私聊或群聊中发送");
        };

        const summarize = async (
            row: RedPacketRow,
            viewerId: string | null,
        ) => {
            const records = await redPackets.listRecords(row.id);
            const mine = viewerId
                ? records.find((r) => r.claimerId === viewerId)
                : undefined;
            return {
                id: row.id,
                sessionId: row.sessionId,
                senderId: row.senderId,
                type: row.type,
                totalAmount: row.totalAmount,
                totalCount: row.totalCount,
                remaining: row.remaining,
                remainCount: row.remainCount,
                status: row.status,
                message: row.message,
                createdAt: row.createdAt,
                claimedCount: records.length,
                myAmount: mine ? mine.amount : null,
            };
        };

        const announce = (
            userIds: string[],
            id: string,
            packet: RedPacketRow,
            claimedCount: number,
        ) => {
            for (const userId of userIds)
                gateway.emitToUser(userId, "redpacket:update", {
                    id,
                    remaining: packet.remaining,
                    remainCount: packet.remainCount,
                    status: packet.status,
                    claimedCount,
                });
        };

        gateway.rpc("redpacket.create", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as {
                sessionId?: unknown;
                type?: unknown;
                totalAmount?: unknown;
                totalCount?: unknown;
                message?: unknown;
            };
            const rawSession = String(params.sessionId ?? "").trim();
            const type = params.type === "lucky" ? "lucky" : "normal";
            const total = amountOf(params.totalAmount, "红包金额");
            const count = amountOf(params.totalCount, "红包个数");
            const blessing = String(params.message ?? "")
                .trim()
                .slice(0, MAX_MESSAGE);
            if (total <= 0) throw new Error("红包金额必须大于 0");
            if (total > MAX_TOTAL_AMOUNT)
                throw new Error("单个红包金额不能超过 2000000 元");
            if (count <= 0) throw new Error("红包个数必须大于 0");
            if (count > MAX_COUNT)
                throw new Error(`红包个数不能超过 ${MAX_COUNT}`);
            if (total < count) throw new Error("金额不足以拆分成这么多个红包");

            const resolved = await resolveSession(me, rawSession);
            const id = crypto.randomUUID();
            const createdAt = new Date();
            await redPackets.create({
                id,
                sessionId: resolved.session,
                senderId: me.id,
                type,
                totalAmount: total,
                totalCount: count,
                message: blessing || DEFAULT_MESSAGE,
                createdAt: createdAt.toISOString(),
                expiredAt: new Date(createdAt.getTime() + TTL_MS).toISOString(),
            });
            const row = await redPackets.getById(id);
            if (!row) throw new Error("红包创建失败");
            const sent = await chat.sendTo(me, resolved.session, {
                content: blessing || DEFAULT_MESSAGE,
                quote: null,
                mentions: null,
                kind: "redpacket",
                file: null,
                redPacket: {
                    id: row.id,
                    senderId: row.senderId,
                    sessionId: row.sessionId,
                    type: row.type,
                    totalAmount: row.totalAmount,
                    totalCount: row.totalCount,
                    status: row.status,
                    remaining: row.remaining,
                    remainCount: row.remainCount,
                    message: row.message,
                    createdAt: row.createdAt,
                    expiredAt: row.expiredAt,
                },
            });
            return { packet: await summarize(row, me.id), message: sent };
        });

        gateway.rpc("redpacket.claim", async (raw, conn) => {
            const me = requireUser(conn);
            const redPacketId = String(
                (raw as unknown as { redPacketId?: unknown }).redPacketId ?? "",
            ).trim();
            if (!redPacketId) throw new Error("缺少红包 ID");
            const row = await redPackets.getById(redPacketId);
            if (!row) throw new Error("红包不存在或已被删除");
            if (row.senderId === me.id) throw new Error("不能领取自己发的红包");
            if (!(await canSeePacket(me, row)))
                throw new Error("你不在该会话中");
            if (
                row.expiredAt &&
                new Date(row.expiredAt).getTime() <= Date.now()
            ) {
                await redPackets.expireIfNeeded(new Date().toISOString());
                throw new Error("红包已过期");
            }
            const claimed = await redPackets.claimedBy(redPacketId, me.id);
            if (claimed !== null) throw new Error("你已经领过这个红包了");

            const records = await redPackets.listRecords(redPacketId);
            const left = row.totalCount - records.length;
            const share =
                row.type === "lucky"
                    ? luckyShare(row.remaining, left)
                    : evenShare(row.remaining, left);
            if (share <= 0) throw new Error("手慢了，红包已被抢完");

            const result = await redPackets.claim({
                redPacketId,
                claimerId: me.id,
                recordId: crypto.randomUUID(),
                amount: share,
                claimedAt: new Date().toISOString(),
            });
            if (!result.ok) {
                if (result.reason === "duplicate")
                    throw new Error("你已经领过这个红包了");
                if (result.reason === "missing") throw new Error("红包不存在");
                throw new Error("手慢了，红包已被抢完");
            }

            const audience = await audienceOf(me, row);
            const fresh = (await redPackets.getById(redPacketId)) ?? row;
            const summary = await summarize(fresh, null);
            announce(audience, redPacketId, fresh, summary.claimedCount);
            return {
                amount: share,
                packet: await summarize(fresh, me.id),
            };
        });

        gateway.rpc("redpacket.detail", async (raw, conn) => {
            const me = requireUser(conn);
            const redPacketId = String(
                (raw as unknown as { redPacketId?: unknown }).redPacketId ?? "",
            ).trim();
            if (!redPacketId) throw new Error("缺少红包 ID");
            const row = await redPackets.getById(redPacketId);
            if (!row) throw new Error("红包不存在或已被删除");
            if (!(await canSeePacket(me, row)))
                throw new Error("你不在该会话中");
            const records = await redPackets.listRecords(redPacketId);
            const users = await accounts.byIds(records.map((r) => r.claimerId));
            const nameById = new Map(users.map((u) => [u.id, u.username]));
            const remarks = await friendships.remarksOf(me.id);
            const remarkById = new Map(
                Object.entries(remarks).map(([key, value]) => [
                    key,
                    value as string,
                ]),
            );
            const detail: RedPacketDetail = {
                packet: await summarize(row, me.id),
                records: records.map((r) => ({
                    userId: r.claimerId,
                    username:
                        remarkById.get(r.claimerId) ??
                        nameById.get(r.claimerId) ??
                        "已注销用户",
                    amount: r.amount,
                    claimedAt: r.claimedAt,
                })),
            };
            return detail;
        });

        gateway.rpc("redpacket.records", async (raw, conn) => {
            const me = requireUser(conn);
            const redPacketId = String(
                (raw as unknown as { redPacketId?: unknown }).redPacketId ?? "",
            ).trim();
            if (!redPacketId) throw new Error("缺少红包 ID");
            const row = await redPackets.getById(redPacketId);
            if (!row) throw new Error("红包不存在或已被删除");
            if (!(await canSeePacket(me, row)))
                throw new Error("你不在该会话中");
            const records = await redPackets.listRecords(redPacketId);
            const users = await accounts.byIds(records.map((r) => r.claimerId));
            const nameById = new Map(users.map((u) => [u.id, u.username]));
            const remarks = await friendships.remarksOf(me.id);
            return records.map((r) => ({
                userId: r.claimerId,
                username:
                    remarks[r.claimerId] ??
                    nameById.get(r.claimerId) ??
                    "已注销用户",
                amount: r.amount,
                claimedAt: r.claimedAt,
            }));
        });

        gateway.rpc("redpacket.expire", async (_raw, conn) => {
            requireUser(conn);
            const ids = await redPackets.expireIfNeeded(
                new Date().toISOString(),
            );
            for (const id of ids)
                gateway.broadcast("redpacket:update", {
                    id,
                    status: "expired",
                });
            return ids.length;
        });

        return undefined;
    },
};
