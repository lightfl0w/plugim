import type { BotScope } from "@plugim/protocol";

export interface AuthDeviceRow {
    id: string;
    label: string;
    userAgent: string;
    ip: string;
    createdAt: string;
    lastSeenAt: string;
    revoked: boolean;
}

export interface AuthSessionsStore {
    create(input: {
        id: string;
        userId: string;
        label: string;
        userAgent: string;
        ip: string;
    }): Promise<AuthDeviceRow>;
    touch(id: string): Promise<void>;
    list(userId: string): Promise<AuthDeviceRow[]>;
    rename(userId: string, id: string, label: string): Promise<boolean>;
    revoke(userId: string, id: string): Promise<boolean>;
    revokeOthers(userId: string, keepId: string): Promise<number>;
    isActive(userId: string, id: string): Promise<boolean>;
}

export interface BotAppRow {
    id: string;
    ownerId: string;
    owner: string;
    name: string;
    tokenHash: string;
    scopes: BotScope[];
    createdAt: string;
    lastUsedAt: string | null;
    revoked: boolean;
}

export interface BotHookRow {
    id: string;
    botId: string;
    botName: string;
    url: string;
    secret: string;
    events: string[];
    enabled: boolean;
    failures: number;
    lastError: string | null;
    createdAt: string;
}

export type BotHook = BotHookRow;

export interface BotsStore {
    createApp(input: {
        ownerId: string;
        name: string;
        tokenHash: string;
        scopes: BotScope[];
    }): Promise<BotAppRow>;
    listApps(ownerId: string): Promise<BotAppRow[]>;
    revokeApp(ownerId: string, id: string): Promise<boolean>;
    byToken(tokenHash: string): Promise<BotAppRow | null>;

    createHook(input: {
        botId: string;
        url: string;
        secret: string;
        events: string[];
    }): Promise<BotHookRow>;
    listHooks(ownerId: string): Promise<BotHookRow[]>;
    setHookEnabled(
        ownerId: string,
        id: string,
        enabled: boolean,
    ): Promise<boolean>;
    removeHook(ownerId: string, id: string): Promise<boolean>;
    hooksOfEvent(event: string): Promise<BotHookRow[]>;
    reportHook(id: string, ok: boolean, error: string | null): Promise<void>;
}
