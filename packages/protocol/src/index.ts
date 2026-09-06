export interface ChatMessage {
    id: string;
    session: string;
    sender: string;
    content: string;
    createdAt: string;
}

export type ServerEventName = "message:new";

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
    sender: string;
    content: string;
}

export interface HistoryParams {
    session: string;
    limit?: number;
}
