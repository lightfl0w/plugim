export interface RedPacketRow {
    id: string;
    sessionId: string;
    senderId: string;
    type: "normal" | "lucky";
    totalAmount: number;
    totalCount: number;
    remaining: number;
    remainCount: number;
    status: "active" | "exhausted" | "expired";
    message?: string | null;
    createdAt: string;
    expiredAt?: string | null;
}

export interface RedPacketClaimRow {
    id: string;
    redPacketId: string;
    claimerId: string;
    amount: number;
    claimedAt: string;
}

export type RedPacketClaimResult =
    | { ok: true; packet: RedPacketRow }
    | { ok: false; reason: "duplicate" | "empty" | "missing" };

export interface RedPacketStore {
    create(input: {
        id: string;
        sessionId: string;
        senderId: string;
        type: "normal" | "lucky";
        totalAmount: number;
        totalCount: number;
        message?: string;
        createdAt: string;
        expiredAt?: string;
    }): Promise<void>;

    getById(id: string): Promise<RedPacketRow | null>;

    claimedBy(redPacketId: string, claimerId: string): Promise<number | null>;

    listRecords(redPacketId: string): Promise<RedPacketClaimRow[]>;

    listSession(sessionId: string): Promise<RedPacketRow[]>;

    claim(input: {
        redPacketId: string;
        claimerId: string;
        recordId: string;
        amount: number;
        claimedAt: string;
    }): Promise<RedPacketClaimResult>;

    expireIfNeeded(now: string): Promise<string[]>;

    claimBack(
        redPacketId: string,
        input: { at: string },
    ): Promise<{
        status: RedPacketRow["status"];
        remaining: number;
        remainCount: number;
        claimedCount: number;
    }>;
}

export type TransferState = "pending" | "accepted" | "rejected" | "refunded";

export interface TransferRow {
    id: string;
    sessionId: string;
    fromId: string;
    toId: string;
    amount: number;
    message?: string | null;
    state: TransferState;
    createdAt: string;
    expiredAt: string;
}

export type TransferCreateResult =
    | { ok: true; transfer: TransferRow }
    | {
          ok: false;
          reason: "missing" | "insufficient" | "duplicate" | "frozen";
      };

export type TransferSettleResult =
    | { ok: true; transfer: TransferRow }
    | { ok: false; reason: "missing" | "conflict" };

export interface AABillRow {
    id: string;
    sessionId: string;
    creatorId: string;
    description: string;
    totalAmount: number;
    settledAmount: number;
    participantIds: string[];
    splitType: "equal" | "custom";
    customSplits: Record<string, number>;
    status: "pending" | "settled" | "cancelled";
    createdAt: string;
    deadline: string;
}

export interface AAPaymentRow {
    id: string;
    billId: string;
    payerId: string;
    amount: number;
    paidAt: string;
}

export type AAPayResult =
    | { ok: true; bill: AABillRow; payment: AAPaymentRow }
    | {
          ok: false;
          reason:
              | "missing"
              | "closed"
              | "duplicate"
              | "amount"
              | "insufficient";
      };

export interface WalletStore {
    balanceOf(userId: string): Promise<number>;
    balancesOf(userIds: string[]): Promise<Record<string, number>>;
    adjustBalance(userId: string, delta: number): Promise<number>;

    transferCreate(input: {
        id: string;
        sessionId: string;
        fromId: string;
        toId: string;
        amount: number;
        message?: string;
        createdAt: string;
        expiredAt: string;
    }): Promise<TransferCreateResult>;
    transferGet(id: string): Promise<TransferRow | null>;
    transferSettle(
        id: string,
        action: "accept" | "reject",
    ): Promise<TransferSettleResult>;
    transferCancelRefund(id: string): Promise<boolean>;
    transferExpireIfNeeded(): Promise<string[]>;
    transferListForUser(userId: string): Promise<TransferRow[]>;
    transferListSession(sessionId: string): Promise<TransferRow[]>;

    aaCreate(input: {
        id: string;
        sessionId: string;
        creatorId: string;
        description: string;
        totalAmount: number;
        participantIds: string[];
        splitType: "equal" | "custom";
        customSplits: Record<string, number>;
        deadline: string;
        createdAt: string;
    }): Promise<void>;
    aaGetById(id: string): Promise<AABillRow | null>;
    aaListSession(sessionId: string): Promise<AABillRow[]>;
    aaListForUser(userId: string): Promise<AABillRow[]>;
    aaPayments(billId: string): Promise<AAPaymentRow[]>;
    aaPay(input: {
        billId: string;
        payerId: string;
        paymentId: string;
        amount: number;
        paidAt: string;
    }): Promise<AAPayResult>;
    aaCancel(id: string): Promise<boolean>;
    aaOverdue(): Promise<AABillRow[]>;
}
