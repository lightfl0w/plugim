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
    remove(userId: string, endpoint: string): Promise<void>;
    ofUser(userId: string): Promise<PushSubscriptionRow[]>;
    ofUsers(userIds: string[]): Promise<PushSubscriptionRow[]>;
    ofAll(): Promise<PushSubscriptionRow[]>;
}

export interface ReadsStore {
    set(
        userId: string,
        session: string,
        at: string,
        seq?: number,
    ): Promise<void>;
    ofSession(
        session: string,
    ): Promise<{ userId: string; at: string; seq: number }[]>;
    cursorsOf(userId: string): Promise<Record<string, number>>;
}
