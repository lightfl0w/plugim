import type { ChatMessage } from "@plugim/protocol";

export type RpcHandler = (
    params: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface GatewayService {
    rpc(method: string, handler: RpcHandler): void;
    broadcast(name: string, payload: unknown): void;
    connections(): number;
}

export interface MessageStore {
    save(input: {
        session: string;
        sender: string;
        content: string;
    }): Promise<ChatMessage>;
    list(session: string, limit: number): Promise<ChatMessage[]>;
}
