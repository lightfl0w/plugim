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
}

export interface AABillStore {
    create(input: {
        id: string;
        creatorId: string;
        sessionId: string;
        description: string;
        totalAmount: number;
        participantIds: string[];
        splitType: "equal" | "custom";
        customSplits?: Record<string, number>;
        deadline: string;
    }): Promise<void>;

    getById(id: string): Promise<null | {
        id: string;
        creatorId: string;
        sessionId: string;
        description: string;
        totalAmount: number;
        settledAmount: number;
        participantIds: string[];
        splitType: "equal" | "custom";
        customSplits?: Record<string, number>;
        deadline: string;
        status: "pending" | "settled" | "cancelled";
        createdAt: string;
    }>;

    addPayment(billId: string, payerId: string, amount: number): Promise<void>;
    updateStatus(
        id: string,
        status: "pending" | "settled" | "cancelled",
    ): Promise<void>;
    cancel(id: string): Promise<void>;
    listParticipantsPayments(
        billId: string,
        userIds: string[],
    ): Promise<Record<string, number>>;
    overdueBills(): Promise<string[]>;
}

export interface TransferStore {
    create(input: {
        id: string;
        fromId: string;
        toId: string;
        amount: number;
        message?: string;
        createdAt: string;
        expiredAt: string;
    }): Promise<void>;

    getById(id: string): Promise<null | {
        id: string;
        fromId: string;
        toId: string;
        amount: number;
        message?: string;
        state: "pending" | "accepted" | "rejected" | "refunded";
        createdAt: string;
        expiredAt: string;
    }>;

    accept(id: string): Promise<boolean>;
    reject(id: string): Promise<boolean>;
    refund(id: string): Promise<boolean>;
    expireIfNeeded(): Promise<string[]>;
    listForUser(userId: string): Promise<
        Array<{
            id: string;
            fromId: string;
            toId: string;
            amount: number;
            message?: string;
            state: string;
            createdAt: string;
            expiredAt: string;
        }>
    >;
}
