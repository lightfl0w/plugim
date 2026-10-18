import type { Plugin } from "@plugim/core";
import type { AABill, AABillDetail, TransferSummary } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface TransferService {
    send(params: {
        sessionId: string;
        toUsername: string;
        amount: number;
        message?: string;
    }): Promise<{ transfer: TransferSummary }>;
    detail(params: { transferId: string }): Promise<{
        transfer: TransferSummary;
    }>;
    accept(params: {
        transferId: string;
    }): Promise<{ transfer: TransferSummary; myBalance: number }>;
    reject(params: {
        transferId: string;
    }): Promise<{ transfer: TransferSummary; myBalance: number }>;
    list(params?: Record<string, never>): Promise<{
        transfers: TransferSummary[];
        balance: number;
    }>;
    expire(): Promise<number>;
    balance(): Promise<{ balance: number }>;
    topup(params: { amount: number }): Promise<{ balance: number }>;
}

export interface AAService {
    create(params: {
        sessionId: string;
        description: string;
        totalAmount: number;
        participantIds?: string[];
        splitType: "equal" | "custom";
        customSplits?: Record<string, number>;
    }): Promise<{ bill: AABill; detail: AABillDetail }>;
    detail(params: { billId: string }): Promise<AABillDetail>;
    candidates(params: { sessionId: string }): Promise<{
        candidates: { userId: string; username: string }[];
    }>;
    list(params?: { sessionId?: string }): Promise<AABill[]>;
    pay(params: {
        billId: string;
        amount?: number;
    }): Promise<{ detail: AABillDetail; myBalance: number }>;
    cancel(params: { billId: string }): Promise<{ detail: AABillDetail }>;
    overdue(): Promise<number>;
}

export interface MoneyApi {
    transfer: TransferService;
    aa: AAService;
}

export const moneyPlugin: Plugin = {
    name: "money",
    description: "转账与 AA 账单客户端服务",
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const transfer: TransferService = {
            send: (params) =>
                rpc.call("transfer.send", params) as Promise<{
                    transfer: TransferSummary;
                }>,
            detail: (params) =>
                rpc.call("transfer.detail", params) as Promise<{
                    transfer: TransferSummary;
                }>,
            accept: (params) =>
                rpc.call("transfer.accept", params) as Promise<{
                    transfer: TransferSummary;
                    myBalance: number;
                }>,
            reject: (params) =>
                rpc.call("transfer.reject", params) as Promise<{
                    transfer: TransferSummary;
                    myBalance: number;
                }>,
            list: (params) =>
                rpc.call("transfer.list", params ?? {}) as Promise<{
                    transfers: TransferSummary[];
                    balance: number;
                }>,
            expire: () => rpc.call("transfer.expire", {}) as Promise<number>,
            balance: () =>
                rpc.call("wallet.balance", {}) as Promise<{ balance: number }>,
            topup: (params) =>
                rpc.call("wallet.topup", params) as Promise<{
                    balance: number;
                }>,
        };
        const aa: AAService = {
            create: (params) =>
                rpc.call("aa.create", params) as Promise<{
                    bill: AABill;
                    detail: AABillDetail;
                }>,
            detail: (params) =>
                rpc.call("aa.detail", params) as Promise<AABillDetail>,
            candidates: (params) =>
                rpc.call("aa.candidates", params) as Promise<{
                    candidates: { userId: string; username: string }[];
                }>,
            list: (params) =>
                rpc.call("aa.list", params ?? {}) as Promise<AABill[]>,
            pay: (params) =>
                rpc.call("aa.pay", params) as Promise<{
                    detail: AABillDetail;
                    myBalance: number;
                }>,
            cancel: (params) =>
                rpc.call("aa.cancel", params) as Promise<{
                    detail: AABillDetail;
                }>,
            overdue: () => rpc.call("aa.overdue", {}) as Promise<number>,
        };
        ctx.provide<TransferService>("transfer", transfer);
        ctx.provide<AAService>("aa", aa);
        ctx.provide<MoneyApi>("money", { transfer, aa });
        return undefined;
    },
};
