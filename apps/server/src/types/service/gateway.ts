import type { Hono } from "hono";
import type { AuthUser } from "../shared";

export interface ConnInfo {
    user: AuthUser | null;
}

export type RpcHandler = (
    params: Record<string, unknown>,
    conn: ConnInfo,
) => Promise<unknown> | unknown;

export type TokenVerifier = (token: string | null) => Promise<AuthUser | null>;

export interface GatewayService {
    rpc(method: string, handler: RpcHandler): void;
    broadcast(name: string, payload: unknown): void;
    emitToUser(userId: string, name: string, payload: unknown): void;
    setAuthenticator(verifier: TokenVerifier): void;
    verify(token: string | null): Promise<AuthUser | null>;
    connections(): number;
    onlineUserIds(): string[];
    isUserOnline(userId: string): boolean;
    kickUser(userId: string): void;
    onOffline(cb: (userId: string) => void): () => void;
    hono(): Hono;
}
