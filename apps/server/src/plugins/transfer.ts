import type { Plugin } from "@plugim/core";
import type { TransferSummary } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ChatService,
    ConnInfo,
    FriendsStore,
    GatewayService,
    TransferRow,
    WalletStore,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const MAX_AMOUNT = 200_000_000;
const MAX_MESSAGE = 50;
const TTL_MS = 24 * 60 * 60 * 1000;

const amountOf = (value: unknown, label: string): number => {
    const num = Number(value);
    if (!Number.isFinite(num) || !Number.isInteger(num))
        throw new Error(`${label}必须是整数（单位：分）`);
    return num;
};

export const transferPlugin: Plugin = {
    name: "transfer",
    description: "转账 RPC",
    provides: ["transfer-rpc"],
    inject: ["gateway", "wallet", "accounts", "friendships", "chat"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const wallet = ctx.get<WalletStore>("wallet");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const chat = ctx.get<ChatService>("chat");

        const summarize = async (
            row: TransferRow,
            me: AuthUser,
        ): Promise<TransferSummary> => {
            const [from, to] = await accounts.byIds([row.fromId, row.toId]);
            const name = (id: string) =>
                (id === row.fromId ? from?.username : to?.username) ??
                "已注销用户";
            return {
                ...row,
                message: row.message ?? undefined,
                myId: me.id,
                fromName: name(row.fromId),
                toName: name(row.toId),
                action: row.fromId === me.id ? "sent" : "received",
            };
        };

        const isFriend = async (a: string, b: string) => {
            const edges = await friendships.edgesOf(a);
            return edges.some(
                (edge) =>
                    edge.status === "accepted" &&
                    (edge.requesterId === b || edge.addresseeId === b),
            );
        };

        const visible = async (me: AuthUser, row: TransferRow) => {
            if (row.fromId === me.id || row.toId === me.id) return true;
            return isFriend(me.id, row.fromId);
        };

        gateway.rpc("transfer.send", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as {
                sessionId?: unknown;
                toUsername?: unknown;
                amount?: unknown;
                message?: unknown;
            };
            const rawSession = String(params.sessionId ?? "").trim();
            const amount = amountOf(params.amount, "转账金额");
            const message = String(params.message ?? "")
                .trim()
                .slice(0, MAX_MESSAGE);
            if (amount <= 0) throw new Error("转账金额必须大于 0");
            if (amount > MAX_AMOUNT)
                throw new Error("单笔转账金额不能超过 2000000 元");
            if (!rawSession.startsWith("p2p:"))
                throw new Error("转账只能在私聊中进行");

            const peerName = String(params.toUsername ?? "")
                .trim()
                .toLowerCase();
            if (!peerName) throw new Error("缺少收款人");
            if (peerName === me.username) throw new Error("不能给自己转账");
            const peer = await accounts.byUsername(peerName);
            if (!peer) throw new Error("对方不存在");
            if (!(await isFriend(me.id, peer.id)))
                throw new Error("你们还不是好友，无法转账");

            const createdAt = new Date();
            const id = crypto.randomUUID();
            const result = await wallet.transferCreate({
                id,
                sessionId: rawSession,
                fromId: me.id,
                toId: peer.id,
                amount,
                message: message || undefined,
                createdAt: createdAt.toISOString(),
                expiredAt: new Date(createdAt.getTime() + TTL_MS).toISOString(),
            });
            if (!result.ok) {
                if (result.reason === "insufficient")
                    throw new Error("余额不足，请先在个人中心充值或收款");
                if (result.reason === "missing") throw new Error("账户不存在");
                throw new Error("转账发起失败，请重试");
            }

            const row = result.transfer;
            const sent = await chat
                .sendTo(me, rawSession, {
                    content: message || "转账",
                    quote: null,
                    mentions: null,
                    kind: "transfer",
                    file: null,
                    transfer: {
                        id: row.id,
                        fromId: row.fromId,
                        toId: row.toId,
                        amount: row.amount,
                        message: row.message ?? undefined,
                        state: row.state,
                        createdAt: row.createdAt,
                        expiredAt: row.expiredAt,
                    },
                })
                .catch(async (err: unknown) => {
                    const refunded = await wallet.transferCancelRefund(row.id);
                    if (refunded)
                        ctx.log.warn(
                            `transfer ${row.id} message send failed, refunded to sender`,
                        );
                    throw err;
                });
            return { transfer: await summarize(row, me), message: sent };
        });

        gateway.rpc("transfer.detail", async (raw, conn) => {
            const me = requireUser(conn);
            const transferId = String(
                (raw as unknown as { transferId?: unknown }).transferId ?? "",
            ).trim();
            if (!transferId) throw new Error("缺少转账 ID");
            const row = await wallet.transferGet(transferId);
            if (!row) throw new Error("转账不存在");
            if (!(await visible(me, row))) throw new Error("你无权查看该转账");
            return { transfer: await summarize(row, me) };
        });

        const settle = async (
            raw: unknown,
            conn: ConnInfo,
            action: "accept" | "reject",
        ) => {
            const me = requireUser(conn);
            const transferId = String(
                (raw as { transferId?: unknown } | null)?.transferId ?? "",
            ).trim();
            if (!transferId) throw new Error("缺少转账 ID");
            const row = await wallet.transferGet(transferId);
            if (!row) throw new Error("转账不存在");
            if (row.toId !== me.id) throw new Error("只有收款人可以操作");
            if (row.state !== "pending") throw new Error("该转账已处理过了");
            if (new Date(row.expiredAt).getTime() <= Date.now()) {
                await wallet.transferExpireIfNeeded();
                throw new Error("该转账已过期，金额已退回");
            }
            const result = await wallet.transferSettle(transferId, action);
            if (!result.ok) {
                if (result.reason === "conflict")
                    throw new Error("该转账已处理过了");
                throw new Error("转账不存在");
            }
            const fresh = result.transfer;
            gateway.emitToUser(row.fromId, "transfer:update", {
                id: fresh.id,
                state: fresh.state,
            });
            return {
                transfer: await summarize(fresh, me),
                myBalance: await wallet.balanceOf(me.id),
            };
        };

        gateway.rpc("transfer.accept", async (raw, conn) =>
            settle(raw, conn, "accept"),
        );
        gateway.rpc("transfer.reject", async (raw, conn) =>
            settle(raw, conn, "reject"),
        );

        gateway.rpc("transfer.list", async (_raw, conn) => {
            const me = requireUser(conn);
            const rows = await wallet.transferListForUser(me.id);
            const list = await Promise.all(
                rows.map((row) => summarize(row, me)),
            );
            return {
                transfers: list,
                balance: await wallet.balanceOf(me.id),
            };
        });

        gateway.rpc("transfer.expire", async (_raw, conn) => {
            requireUser(conn);
            const ids = await wallet.transferExpireIfNeeded();
            for (const id of ids)
                gateway.broadcast("transfer:update", { id, state: "refunded" });
            return ids.length;
        });

        gateway.rpc("wallet.balance", async (_raw, conn) => {
            const me = requireUser(conn);
            return { balance: await wallet.balanceOf(me.id) };
        });

        gateway.rpc("wallet.topup", async (raw, conn) => {
            const me = requireUser(conn);
            const amount = amountOf(
                (raw as { amount?: unknown } | null)?.amount,
                "充值金额",
            );
            if (amount <= 0) throw new Error("充值金额必须大于 0");
            if (amount > MAX_AMOUNT)
                throw new Error("单次充值金额不能超过 2000000 元");
            const balance = await wallet.adjustBalance(me.id, amount);
            return { balance };
        });

        return undefined;
    },
};
