import type {
    ChatMessage,
    FileMeta,
    GroupRole,
    MessageKind,
    MessageQuote,
    User,
} from "@plugim/protocol";
import type { Hono } from "hono";

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
    verify(token: string | null): Promise<AuthUser | null>;
    connections(): number;
    onlineUserIds(): string[];
    isUserOnline(userId: string): boolean;
    kickUser(userId: string): void;
    onOffline(cb: (userId: string) => void): () => void;
    hono(): Hono;
}

export interface MessageTrendPoint {
    date: string;
    messages: number;
    senders: number;
}

export interface MessageStore {
    save(input: {
        session: string;
        sender: string;
        content: string;
        quote?: MessageQuote | null;
        mentions?: string[] | null;
        kind?: MessageKind;
        file?: FileMeta | null;
    }): Promise<ChatMessage>;
    list(
        session: string,
        limit: number,
        before?: string,
        after?: string,
        beforeId?: string,
        afterId?: string,
    ): Promise<ChatMessage[]>;
    byId(id: string): Promise<ChatMessage | null>;
    markRecalled(id: string): Promise<string | null>;
    search(params: {
        keyword?: string;
        session?: string;
        sessions?: string[];
        sender?: string;
        media?: boolean;
        offset: number;
        limit: number;
    }): Promise<{ rows: ChatMessage[]; total: number }>;
    deleteOlderThan(iso: string): Promise<ChatMessage[]>;
    countByContent(content: string): Promise<number>;
    trend(days: number): Promise<MessageTrendPoint[]>;
    count(): Promise<number>;
    mediaBytes(): Promise<number>;
}

export interface MediaFileRow {
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderId: string;
    createdAt: string;
}

export interface MediaFilesStore {
    save(row: MediaFileRow): Promise<void>;
    byKey(key: string): Promise<MediaFileRow | null>;
    list(params: {
        offset: number;
        limit: number;
    }): Promise<{ rows: MediaFileRow[]; total: number }>;
    olderThan(iso: string): Promise<MediaFileRow[]>;
    totalBytes(): Promise<number>;
    count(): Promise<number>;
    remove(key: string): Promise<void>;
}

export interface UserWithHash extends User {
    passwordHash: string;
    isAdmin: boolean;
    banned: boolean;
    tokenVersion: number;
}

export interface AdminUserRow extends User {
    isAdmin: boolean;
    banned: boolean;
}

export interface AccountsStore {
    create(username: string, passwordHash: string): Promise<User>;
    byUsername(username: string): Promise<UserWithHash | null>;
    byId(id: string): Promise<User | null>;
    byIds(ids: string[]): Promise<User[]>;
    fullById(id: string): Promise<UserWithHash | null>;
    listAll(): Promise<AdminUserRow[]>;
    setFlag(
        id: string,
        flag: "isAdmin" | "banned",
        value: boolean,
    ): Promise<void>;
    setPassword(id: string, passwordHash: string): Promise<number>;
    count(): Promise<number>;
}

export interface GroupRow {
    id: string;
    name: string;
    ownerId: string;
    notice: string;
    muteAll: boolean;
    noFriendAdd: boolean;
    inviteCode: string | null;
    inviteExpiresAt: string | null;
    joinApproval: boolean;
    createdAt: string;
}

export interface GroupMemberRow {
    userId: string;
    role: GroupRole;
    muted: boolean;
    joinedAt: string;
}

export interface JoinRequestRow {
    groupId: string;
    userId: string;
    message: string;
    createdAt: string;
}

export interface JoinRequestsStore {
    upsert(input: {
        groupId: string;
        userId: string;
        message: string;
    }): Promise<void>;
    byGroup(groupId: string): Promise<JoinRequestRow[]>;
    countByGroup(groupId: string): Promise<number>;
    remove(groupId: string, userId: string): Promise<void>;
}

export interface GroupsStore {
    create(name: string, ownerId: string): Promise<GroupRow>;
    byId(id: string): Promise<GroupRow | null>;
    byInviteCode(code: string): Promise<GroupRow | null>;
    remove(id: string): Promise<void>;
    rename(id: string, name: string): Promise<void>;
    setNotice(id: string, notice: string): Promise<void>;
    setMuteAll(id: string, on: boolean): Promise<void>;
    setNoFriendAdd(id: string, on: boolean): Promise<void>;
    setInvite(
        id: string,
        code: string | null,
        expiresAt: string | null,
    ): Promise<void>;
    setJoinApproval(id: string, on: boolean): Promise<void>;
    addMember(groupId: string, userId: string): Promise<void>;
    removeMember(groupId: string, userId: string): Promise<void>;
    setRole(groupId: string, userId: string, role: GroupRole): Promise<void>;
    setMuted(groupId: string, userId: string, muted: boolean): Promise<void>;
    membersOf(groupId: string): Promise<GroupMemberRow[]>;
    memberIdsOf(groupId: string): Promise<string[]>;
    groupsOf(userId: string): Promise<GroupRow[]>;
    listAll(): Promise<(GroupRow & { memberCount: number })[]>;
    friendAddBlocked(aId: string, bId: string): Promise<boolean>;
}

export interface GroupFileRow {
    groupId: string;
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderId: string;
    createdAt: string;
}

export interface GroupFilesStore {
    save(row: GroupFileRow): Promise<void>;
    byKey(groupId: string, key: string): Promise<GroupFileRow | null>;
    list(
        groupId: string,
        params: { offset: number; limit: number },
    ): Promise<{ rows: GroupFileRow[]; total: number }>;
    countByKey(key: string): Promise<number>;
    remove(groupId: string, key: string): Promise<void>;
}

export interface ChatSendPayload {
    content: string;
    quote: MessageQuote | null;
    mentions: string[] | null;
    kind: MessageKind;
    file: FileMeta | null;
}

export interface ChatService {
    sendTo(
        user: AuthUser,
        session: string,
        payload: ChatSendPayload,
    ): Promise<ChatMessage>;
}

export interface GroupAclService {
    requireMembership(
        groupId: string,
        me: AuthUser,
    ): Promise<{ row: GroupRow; members: GroupMemberRow[]; mine: GroupRole }>;
    sessionOf(groupId: string): string;
}

export interface ReadsStore {
    set(userId: string, session: string, at: string): Promise<void>;
    ofSession(session: string): Promise<{ userId: string; at: string }[]>;
}

export interface SettingsStore {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
}

export interface PushSubscriptionRow {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    createdAt: string;
}

export interface PushStore {
    save(input: {
        userId: string;
        endpoint: string;
        p256dh: string;
        auth: string;
    }): Promise<void>;
    remove(endpoint: string): Promise<void>;
    ofUser(userId: string): Promise<PushSubscriptionRow[]>;
    ofUsers(userIds: string[]): Promise<PushSubscriptionRow[]>;
    ofAll(): Promise<PushSubscriptionRow[]>;
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
    setRemark(ownerId: string, friendId: string, remark: string): Promise<void>;
    remarksOf(ownerId: string): Promise<Record<string, string>>;
}
