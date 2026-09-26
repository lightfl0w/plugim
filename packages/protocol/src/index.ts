export interface MessageQuote {
    sender: string;
    content: string;
}

export type MessageKind =
    | "text"
    | "image"
    | "audio"
    | "video"
    | "file"
    | "merge";

export interface MergedChat {
    sender: string;
    content: string;
    kind?: MessageKind;
    createdAt: string;
}

export interface MergePayload {
    merge: 1;
    title: string;
    list: MergedChat[];
}

export interface FileMeta {
    name: string;
    size: number;
    mime?: string;
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
    remarks: Record<string, string>;
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
    noFriendAdd: boolean;
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

export type CallKind = "screen" | "voice" | "video";

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

export interface GroupFileItem {
    key: string;
    name: string;
    mime: string;
    size: number;
    uploader: string;
    createdAt: string;
}

export interface GroupCallInfo {
    roomId: string;
    groupId: string;
    groupName: string;
    kind: CallKind;
    host: string;
    members: string[];
}

export type GroupCallEventType = "invite" | "join" | "leave" | "end";

export interface GroupCallEvent {
    type: GroupCallEventType;
    roomId: string;
    groupId: string;
    groupName: string;
    kind: CallKind;
    from: string;
}

export interface GroupCallSignal {
    type: "offer" | "answer" | "ice";
    roomId: string;
    from: string;
    sdp?: string;
    candidate?: unknown;
}

export type ServerEventName =
    | "message:new"
    | "message:recalled"
    | "friend:update"
    | "group:update"
    | "presence:update"
    | "receipt:update"
    | "screen:signal"
    | "group:call"
    | "group:call:signal";

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
    after?: string;
    beforeId?: string;
    afterId?: string;
}

export interface RecallParams {
    id: string;
}

export interface FriendTargetParams {
    username: string;
}

export interface FriendRemarkParams {
    username: string;
    remark: string;
}

export interface UserInfoResult {
    username: string;
    createdAt: string;
}

export interface MessageSearchParams {
    keyword: string;
    session?: string;
    offset?: number;
    limit?: number;
}

export interface MessageSearchResult {
    hits: ChatMessage[];
    total: number;
}
