import type { Plugin } from "@plugim/core";
import type { AABillDetail } from "@plugim/protocol";
import type {
    AABillRow,
    AccountsStore,
    AuthUser,
    ChatService,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupAclService,
    GroupsStore,
    WalletStore,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const MAX_AMOUNT = 200_000_000;
const MAX_MEMBERS = 200;
const MAX_DESCRIPTION = 50;
const DEFAULT_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000;

const amountOf = (value: unknown, label: string): number => {
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num))
        throw new Error(`${label}必须是整数（单位：分）`);
    return num;
};

const shareOf = (bill: AABillRow, userId: string): number | null => {
    if (!bill.participantIds.includes(userId)) return null;
    if (bill.splitType === "custom") return bill.customSplits[userId] ?? null;
    return Math.floor(bill.totalAmount / bill.participantIds.length);
};

export const aaPlugin: Plugin = {
    name: "aa",
    description: "AA 账单 RPC",
    provides: ["aa-rpc"],
    inject: [
        "gateway",
        "wallet",
        "accounts",
        "friendships",
        "groups",
        "group-acl",
        "chat",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const wallet = ctx.get<WalletStore>("wallet");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");
        const acl = ctx.get<GroupAclService>("group-acl");
        const chat = ctx.get<ChatService>("chat");

        const nameMap = async (ids: string[]) => {
            const users = await accounts.byIds(ids);
            const map = new Map(users.map((u) => [u.id, u.username]));
            const remarks =
                ids.length > 0 ? await friendships.remarksOf(ids[0]) : {};
            return { map, remarks };
        };

        const resolveSession = async (
            me: AuthUser,
            rawSession: string,
        ): Promise<{ session: string; notifyUserIds: string[] }> => {
            if (rawSession.startsWith("p2p:")) {
                const peerName = rawSession.slice(4).trim();
                const peer = await accounts.byUsername(peerName.toLowerCase());
                if (!peer) throw new Error("对方不存在");
                if (peer.id === me.id)
                    throw new Error("不能和自己创建 AA 账单");
                return {
                    session: rawSession,
                    notifyUserIds: [me.id, peer.id],
                };
            }
            if (rawSession.startsWith("g:")) {
                const groupId = rawSession.slice(2);
                const { row } = await acl.requireMembership(groupId, me);
                return {
                    session: rawSession,
                    notifyUserIds: await groups.memberIdsOf(row.id),
                };
            }
            throw new Error("AA 账单只能在私聊或群聊中创建");
        };

        const audienceOf = async (
            me: AuthUser,
            bill: AABillRow,
        ): Promise<string[]> => {
            if (bill.sessionId.startsWith("p2p:"))
                return [me.id, ...bill.participantIds].filter(
                    (id, i, arr) => arr.indexOf(id) === i,
                );
            try {
                await acl.requireMembership(bill.sessionId.slice(2), me);
            } catch {
                return [];
            }
            return groups.memberIdsOf(bill.sessionId.slice(2));
        };

        const canSee = async (me: AuthUser, bill: AABillRow) => {
            if (bill.creatorId === me.id) return true;
            if (bill.participantIds.includes(me.id)) return true;
            if (bill.sessionId.startsWith("g:")) {
                try {
                    await acl.requireMembership(bill.sessionId.slice(2), me);
                    return true;
                } catch {
                    return false;
                }
            }
            const [, pair] = bill.sessionId.split(":");
            const names = (pair ?? "").split("|");
            return names.includes(me.username);
        };

        const buildDetail = async (
            bill: AABillRow,
            me: AuthUser,
        ): Promise<AABillDetail> => {
            const payments = await wallet.aaPayments(bill.id);
            const ids = [
                ...new Set([
                    bill.creatorId,
                    ...bill.participantIds,
                    ...payments.map((p) => p.payerId),
                ]),
            ];
            const { map, remarks } = await nameMap(ids);
            const label = (id: string) =>
                remarks[id] ?? map.get(id) ?? "已注销用户";
            const paidByUser = new Map(
                payments.map((p) => [p.payerId, p.amount]),
            );
            const share = shareOf(bill, me.id);
            const mine = paidByUser.get(me.id) ?? 0;
            return {
                bill,
                share: share ?? 0,
                paidAmount: mine,
                paid: mine > 0,
                overdue:
                    bill.status === "pending" &&
                    new Date(bill.deadline).getTime() <= Date.now(),
                creatorName: label(bill.creatorId),
                payments: payments.map((p) => ({
                    userId: p.payerId,
                    username: label(p.payerId),
                    amount: p.amount,
                    paidAt: p.paidAt,
                })),
                members: bill.participantIds.map((id) => ({
                    userId: id,
                    username: label(id),
                    share: shareOf(bill, id) ?? 0,
                    paidAmount: paidByUser.get(id) ?? 0,
                    paid: paidByUser.has(id),
                })),
            };
        };

        const announce = async (bill: AABillRow, me: AuthUser) => {
            const audience = await audienceOf(me, bill);
            for (const userId of audience)
                gateway.emitToUser(userId, "aabill:update", {
                    id: bill.id,
                    status: bill.status,
                    settledAmount: bill.settledAmount,
                });
        };

        gateway.rpc("aa.create", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as {
                sessionId?: unknown;
                description?: unknown;
                totalAmount?: unknown;
                participantIds?: unknown;
                splitType?: unknown;
                customSplits?: unknown;
            };
            const rawSession = String(params.sessionId ?? "").trim();
            const total = amountOf(params.totalAmount, "账单总额");
            if (total <= 0) throw new Error("账单总额必须大于 0");
            if (total > MAX_AMOUNT)
                throw new Error("账单总额不能超过 2000000 元");
            const description =
                String(params.description ?? "")
                    .trim()
                    .slice(0, MAX_DESCRIPTION) || "AA 账单";
            const splitType =
                params.splitType === "custom" ? "custom" : "equal";

            const resolved = await resolveSession(me, rawSession);
            const memberIds = resolved.session.startsWith("g:")
                ? await groups.memberIdsOf(resolved.session.slice(2))
                : [];
            const requested = Array.isArray(params.participantIds)
                ? [
                      ...new Set(
                          params.participantIds
                              .filter((v): v is string => typeof v === "string")
                              .filter((v) => v !== me.id),
                      ),
                  ]
                : [];
            const candidates =
                requested.length > 0
                    ? requested
                    : memberIds.filter((id) => id !== me.id);
            if (candidates.length === 0)
                throw new Error("AA 账单至少要有 1 位参与者");
            if (candidates.length > MAX_MEMBERS)
                throw new Error(`参与者不能超过 ${MAX_MEMBERS} 人`);
            if (resolved.session.startsWith("g:")) {
                const allowed = new Set(memberIds);
                if (candidates.some((id) => !allowed.has(id)))
                    throw new Error("参与者必须是群成员");
            }

            const customSplits: Record<string, number> = {};
            if (splitType === "custom") {
                const rawSplits =
                    params.customSplits &&
                    typeof params.customSplits === "object" &&
                    !Array.isArray(params.customSplits)
                        ? (params.customSplits as Record<string, unknown>)
                        : {};
                let sum = 0;
                for (const id of candidates) {
                    const value = amountOf(rawSplits[id], "分摊金额");
                    if (value <= 0)
                        throw new Error("每位参与者的分摊金额必须大于 0");
                    customSplits[id] = value;
                    sum += value;
                }
                if (sum !== total)
                    throw new Error("自定义分摊金额之和必须等于账单总额");
            } else if (total < candidates.length) {
                throw new Error("账单总额不足以按人数均分");
            }

            const id = crypto.randomUUID();
            const createdAt = new Date();
            const deadline = new Date(
                createdAt.getTime() + DEFAULT_DEADLINE_MS,
            );
            await wallet.aaCreate({
                id,
                sessionId: resolved.session,
                creatorId: me.id,
                description,
                totalAmount: total,
                participantIds: candidates,
                splitType,
                customSplits,
                deadline: deadline.toISOString(),
                createdAt: createdAt.toISOString(),
            });
            const bill = await wallet.aaGetById(id);
            if (!bill) throw new Error("账单创建失败");
            const sent = await chat.sendTo(me, resolved.session, {
                content: description,
                quote: null,
                mentions: null,
                kind: "aabill",
                file: null,
                aaBill: {
                    id: bill.id,
                    sessionId: bill.sessionId,
                    creatorId: bill.creatorId,
                    description: bill.description,
                    totalAmount: bill.totalAmount,
                    settledAmount: bill.settledAmount,
                    participantIds: bill.participantIds,
                    splitType: bill.splitType,
                    status: bill.status,
                    createdAt: bill.createdAt,
                    deadline: bill.deadline,
                },
            });
            return {
                bill,
                detail: await buildDetail(bill, me),
                message: sent,
            };
        });

        gateway.rpc("aa.candidates", async (raw, conn) => {
            const me = requireUser(conn);
            const session = String(
                (raw as unknown as { sessionId?: unknown }).sessionId ?? "",
            ).trim();
            if (session.startsWith("g:")) {
                const groupId = session.slice(2);
                const { row, members } = await acl.requireMembership(
                    groupId,
                    me,
                );
                const ids = members
                    .filter((m) => m.userId !== me.id)
                    .map((m) => m.userId);
                const users = await accounts.byIds(ids);
                return {
                    candidates: users.map((u) => ({
                        userId: u.id,
                        username: u.username,
                    })),
                    session: row.id ? `g:${row.id}` : session,
                };
            }
            if (session.startsWith("p2p:")) {
                const peer = await accounts.byUsername(
                    session.slice(4).trim().toLowerCase(),
                );
                if (!peer) throw new Error("对方不存在");
                return {
                    candidates: [
                        {
                            userId: peer.id,
                            username: peer.username,
                        },
                    ],
                };
            }
            throw new Error("AA 账单只能在私聊或群聊中创建");
        });

        gateway.rpc("aa.detail", async (raw, conn) => {
            const me = requireUser(conn);
            const billId = String(
                (raw as unknown as { billId?: unknown }).billId ?? "",
            ).trim();
            if (!billId) throw new Error("缺少账单 ID");
            const bill = await wallet.aaGetById(billId);
            if (!bill) throw new Error("账单不存在或已被删除");
            if (!(await canSee(me, bill))) throw new Error("你无权查看该账单");
            return await buildDetail(bill, me);
        });

        gateway.rpc("aa.list", async (raw, conn) => {
            const me = requireUser(conn);
            const session = String(
                (raw as unknown as { sessionId?: unknown }).sessionId ?? "",
            ).trim();
            if (session) {
                const rows = await wallet.aaListSession(session);
                const visibleRows = [];
                for (const row of rows)
                    if (await canSee(me, row)) visibleRows.push(row);
                return visibleRows;
            }
            return await wallet.aaListForUser(me.id);
        });

        gateway.rpc("aa.pay", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as {
                billId?: unknown;
                amount?: unknown;
            };
            const billId = String(params.billId ?? "").trim();
            if (!billId) throw new Error("缺少账单 ID");
            const bill = await wallet.aaGetById(billId);
            if (!bill) throw new Error("账单不存在或已被删除");
            if (!(await canSee(me, bill))) throw new Error("你无权操作该账单");
            const share = shareOf(bill, me.id);
            if (share === null) throw new Error("你不是该账单的参与者");
            const amount =
                params.amount === undefined
                    ? share
                    : amountOf(params.amount, "付款金额");
            const result = await wallet.aaPay({
                billId,
                payerId: me.id,
                paymentId: crypto.randomUUID(),
                amount,
                paidAt: new Date().toISOString(),
            });
            if (!result.ok) {
                if (result.reason === "duplicate")
                    throw new Error("你已经付过了");
                if (result.reason === "insufficient")
                    throw new Error("余额不足，无法支付这笔 AA 账单");
                if (result.reason === "amount")
                    throw new Error("付款金额与你的分摊金额不一致");
                if (result.reason === "closed")
                    throw new Error("该账单已结束，无法付款");
                throw new Error("账单不存在");
            }
            await announce(result.bill, me);
            return {
                detail: await buildDetail(result.bill, me),
                myBalance: await wallet.balanceOf(me.id),
            };
        });

        gateway.rpc("aa.cancel", async (raw, conn) => {
            const me = requireUser(conn);
            const billId = String(
                (raw as unknown as { billId?: unknown }).billId ?? "",
            ).trim();
            if (!billId) throw new Error("缺少账单 ID");
            const bill = await wallet.aaGetById(billId);
            if (!bill) throw new Error("账单不存在或已被删除");
            if (bill.creatorId !== me.id)
                throw new Error("只有发起人可以取消账单");
            const ok = await wallet.aaCancel(billId);
            if (!ok) throw new Error("该账单已结束，无法取消");
            const fresh = await wallet.aaGetById(billId);
            if (!fresh) throw new Error("账单不存在");
            await announce(fresh, me);
            return { detail: await buildDetail(fresh, me) };
        });

        gateway.rpc("aa.overdue", async (_raw, conn) => {
            requireUser(conn);
            const bills = await wallet.aaOverdue();
            for (const bill of bills)
                gateway.broadcast("aabill:update", {
                    id: bill.id,
                    status: "overdue",
                });
            return bills.length;
        });

        return undefined;
    },
};
