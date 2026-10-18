import type {
    AABillInfo,
    FileMeta,
    MessageKind,
    MessageQuote,
    RedPacketInfo,
    TransferInfo,
    User,
} from "@plugim/protocol";

export type { User } from "@plugim/protocol";

export interface AuthUser {
    id: string;
    username: string;
    mustChange?: boolean;
}

export interface ConnInfo {
    user: AuthUser | null;
}

export type RpcHandler = (
    params: Record<string, unknown>,
    conn: ConnInfo,
) => Promise<unknown> | unknown;

export type TokenVerifier = (token: string | null) => Promise<AuthUser | null>;

export interface MessageTrendPoint {
    date: string;
    messages: number;
    senders: number;
}

export interface ChatSendPayload {
    content: string;
    quote: MessageQuote | null;
    mentions: string[] | null;
    kind: MessageKind;
    file: FileMeta | null;
    redPacket?: RedPacketInfo | null;
    transfer?: TransferInfo | null;
    aaBill?: AABillInfo | null;
}

export interface UserWithHash extends User {
    passwordHash: string;
    isAdmin: boolean;
    banned: boolean;
    tokenVersion: number;
    deptId: string | null;
    title: string | null;
    mustChangePassword: boolean;
}

export interface AdminUserRow extends User {
    isAdmin: boolean;
    banned: boolean;
    deptId: string | null;
    title: string | null;
}

export type FriendStatus = "pending" | "accepted" | "blocked";
