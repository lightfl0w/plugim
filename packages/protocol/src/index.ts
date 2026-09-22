export interface MessageQuote {
    sender: string;
    content: string;
}

export type MessageKind = "text" | "image" | "audio" | "video" | "file";

export interface FileMeta {
    name: string;
    size: number;
}

export interface ChatMessage {
    id: string;
    session: string;
    sender: string;
    content: string;
    createdAt: string;
    recalledAt?: string | null;
    quote?: MessageQuote | null;
    mentions?: string[] | null;
    kind?: MessageKind;
    file?: FileMeta | null;
}

export interface User {
    id: string;
    username: string;
    createdAt: string;
}

export interface AuthSuccess {
    token: string;
    user: User;
}

export interface CredentialsParams {
    username: string;
    password: string;
}

export interface FriendListResult {
    friends: string[];
    incoming: string[];
    outgoing: string[];
    blocked: string[];
}

export interface MessageRecalledEvent {
    id: string;
    session: string;
    recalledAt: string;
}

export type GroupRole = "owner" | "admin" | "member";

export interface GroupInfo {
    id: string;
    name: string;
    ownerId: string;
    notice: string;
    muteAll: boolean;
    createdAt: string;
    memberCount: number;
    myRole: GroupRole | null;
}

export interface GroupMember {
    username: string;
    role: GroupRole;
    muted: boolean;
    joinedAt: string;
}

export interface PresenceUpdate {
    username: string;
    online: boolean;
}

export interface ReceiptUpdate {
    session: string;
    username: string;
    at: string;
}

export type ScreenSignalType =
    | "invite"
    | "accept"
    | "decline"
    | "hangup"
    | "offer"
    | "answer"
    | "ice";

export type CallKind = "screen" | "voice";

export interface ScreenSignal {
    type: ScreenSignalType;
    callId: string;
    from: string;
    kind?: CallKind;
    sdp?: string;
    candidate?: unknown;
}

export interface IceServerConfig {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export type ServerEventName =
    | "message:new"
    | "message:recalled"
    | "friend:update"
    | "group:update"
    | "presence:update"
    | "receipt:update"
    | "screen:signal";

export interface ServerEvent<P = unknown> {
    kind: "event";
    name: ServerEventName;
    payload: P;
}

export interface RpcRequest {
    kind: "rpc";
    id: string;
    method: string;
    params: Record<string, unknown>;
}

export interface RpcOk {
    kind: "rpc:ok";
    id: string;
    result: unknown;
}

export interface RpcErr {
    kind: "rpc:err";
    id: string;
    message: string;
}

export type Envelope = ServerEvent | RpcRequest | RpcOk | RpcErr;

export interface SendMessageParams {
    session: string;
    content: string;
    quote?: MessageQuote | null;
    mentions?: string[] | null;
    kind?: MessageKind;
    file?: FileMeta | null;
}

export interface HistoryParams {
    session: string;
    limit?: number;
    before?: string;
}

export interface RecallParams {
    id: string;
}

export interface FriendTargetParams {
    username: string;
}

export interface UserInfoResult {
    username: string;
    createdAt: string;
}
