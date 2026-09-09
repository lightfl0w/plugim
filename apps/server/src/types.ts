import type { ChatMessage, User } from "@plugim/protocol";

export interface AuthUser {
    id: string;
    username: string;
}

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
    connections(): number;
}

export interface MessageStore {
    save(input: {
        session: string;
        sender: string;
        content: string;
    }): Promise<ChatMessage>;
    list(
        session: string,
        limit: number,
        before?: string,
    ): Promise<ChatMessage[]>;
    byId(id: string): Promise<ChatMessage | null>;
    markRecalled(id: string): Promise<string | null>;
}

export interface UserWithHash extends User {
    passwordHash: string;
}

export interface AccountsStore {
    create(username: string, passwordHash: string): Promise<User>;
    byUsername(username: string): Promise<UserWithHash | null>;
    byId(id: string): Promise<User | null>;
    byIds(ids: string[]): Promise<User[]>;
}

export type FriendStatus = "pending" | "accepted" | "blocked";

export interface FriendEdge {
    requesterId: string;
    addresseeId: string;
    status: FriendStatus;
    createdAt: string;
}

export interface FriendsStore {
    request(requesterId: string, addresseeId: string): Promise<void>;
    accept(requesterId: string, addresseeId: string): Promise<void>;
    removeBetween(aId: string, bId: string): Promise<void>;
    block(blockerId: string, targetId: string): Promise<void>;
    unblock(blockerId: string, targetId: string): Promise<void>;
    edgesOf(userId: string): Promise<FriendEdge[]>;
}
