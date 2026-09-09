import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";

export interface CacheService {
    getMessages(owner: string, session: string): Promise<ChatMessage[]>;
    putMessages(
        owner: string,
        session: string,
        messages: ChatMessage[],
    ): Promise<void>;
    recallMessage(
        owner: string,
        session: string,
        id: string,
        recalledAt: string,
    ): Promise<void>;
    getUnread(owner: string): Promise<Record<string, number>>;
    setUnread(owner: string, unread: Record<string, number>): Promise<void>;
}

interface CachedMessage {
    key: string;
    owner: string;
    session: string;
    createdAtMs: number;
    message: ChatMessage;
}

const DB_NAME = "plugim";
const DB_VERSION = 1;
const SOFT_LIMIT = 600;
const HARD_LIMIT = 500;

let dbPromise: Promise<IDBDatabase> | undefined;

const openDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                const messages = db.createObjectStore("messages", {
                    keyPath: "key",
                });
                messages.createIndex("owner_session", ["owner", "session"]);
                db.createObjectStore("kv");
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
                reject(request.error ?? new Error("无法打开本地缓存"));
        });
    }
    return dbPromise;
};

const toPromise = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(request.error ?? new Error("缓存读写失败"));
    });

const txDone = (tx: IDBTransaction): Promise<void> =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("缓存事务失败"));
    });

export const cachePlugin: Plugin = {
    name: "cache",
    description: "IndexedDB 消息缓存(秒开与离线查看)",
    provides: ["cache"],
    async apply(ctx) {
        ctx.provide<CacheService>("cache", {
            async getMessages(owner, session) {
                const db = await openDb();
                const tx = db.transaction("messages", "readonly");
                const index = tx.objectStore("messages").index("owner_session");
                const rows = await toPromise(
                    index.getAll(IDBKeyRange.only([owner, session])),
                );
                return (rows as CachedMessage[])
                    .map((row) => row.message)
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
            },

            async putMessages(owner, session, messages) {
                if (messages.length === 0) return;
                const db = await openDb();
                const tx = db.transaction("messages", "readwrite");
                const store = tx.objectStore("messages");
                for (const message of messages) {
                    store.put({
                        key: `${owner}:${session}:${message.id}`,
                        owner,
                        session,
                        createdAtMs: Date.parse(message.createdAt),
                        message,
                    } satisfies CachedMessage);
                }
                await txDone(tx);

                const countTx = db.transaction("messages", "readonly");
                const count = await toPromise(
                    countTx
                        .objectStore("messages")
                        .count(IDBKeyRange.only([owner, session])),
                );
                if (count <= SOFT_LIMIT) return;

                const trimTx = db.transaction("messages", "readwrite");
                const trimStore = trimTx.objectStore("messages");
                const stale = (
                    (await toPromise(
                        trimStore
                            .index("owner_session")
                            .getAll(IDBKeyRange.only([owner, session])),
                    )) as CachedMessage[]
                )
                    .sort((a, b) => a.createdAtMs - b.createdAtMs)
                    .slice(0, count - HARD_LIMIT);
                for (const row of stale) trimStore.delete(row.key);
                await txDone(trimTx);
            },

            async recallMessage(owner, session, id, recalledAt) {
                const db = await openDb();
                const key = `${owner}:${session}:${id}`;
                const tx = db.transaction("messages", "readwrite");
                const store = tx.objectStore("messages");
                const row = (await toPromise(store.get(key))) as
                    | CachedMessage
                    | undefined;
                if (row) {
                    row.message = { ...row.message, recalledAt };
                    store.put(row);
                }
                await txDone(tx);
            },

            async getUnread(owner) {
                const db = await openDb();
                const tx = db.transaction("kv", "readonly");
                const value = await toPromise(
                    tx.objectStore("kv").get(`unread:${owner}`),
                );
                return (value as Record<string, number> | undefined) ?? {};
            },

            async setUnread(owner, unread) {
                const db = await openDb();
                const tx = db.transaction("kv", "readwrite");
                tx.objectStore("kv").put(unread, `unread:${owner}`);
                await txDone(tx);
            },
        });
        return undefined;
    },
};
