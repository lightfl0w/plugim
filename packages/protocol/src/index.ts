export interface ChatMessage {
    id: string;
    session: string;
    sender: string;
    content: string;
    createdAt: string;
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

export type ServerEventName = "message:new" | "friend:update";

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
}

export interface HistoryParams {
    session: string;
    limit?: number;
}

export interface FriendTargetParams {
    username: string;
}
