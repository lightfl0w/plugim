import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface FriendsService {
    cached(): FriendListResult | null;
    refresh(): Promise<FriendListResult>;
    request(username: string): Promise<void>;
    accept(username: string): Promise<void>;
    reject(username: string): Promise<void>;
    remove(username: string): Promise<void>;
    block(username: string): Promise<void>;
    unblock(username: string): Promise<void>;
    onUpdate(cb: () => void): () => void;
}

export const friendsPlugin: Plugin = {
    name: "friends",
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const listeners = new Set<() => void>();
        let cache: FriendListResult | null = null;
        let inflight: Promise<FriendListResult> | null = null;

        const emit = () => {
            for (const cb of listeners) cb();
        };

        const fetchList = () => {
            if (!inflight) {
                inflight = rpc
                    .call("friend.list", {})
                    .then((result) => {
                        inflight = null;
                        cache = result as FriendListResult;
                        emit();
                        return cache;
                    })
                    .catch((err) => {
                        inflight = null;
                        throw err;
                    });
            }
            return inflight;
        };

        const mutate = (method: string, username: string) =>
            rpc.call(method, { username }).then((result) => {
                cache = result as FriendListResult;
                emit();
            });

        ctx.on("server:friend:update", () => {
            void fetchList().catch(() => undefined);
        });

        const refreshOnOpen = (status: string) => {
            if (status === "open") void fetchList().catch(() => undefined);
        };
        if (rpc.status() === "open") void fetchList().catch(() => undefined);
        rpc.onStatus(refreshOnOpen);

        ctx.provide<FriendsService>("friends", {
            cached: () => cache,
            refresh: fetchList,
            request: (u) => mutate("friend.request", u),
            accept: (u) => mutate("friend.accept", u),
            reject: (u) => mutate("friend.reject", u),
            remove: (u) => mutate("friend.remove", u),
            block: (u) => mutate("friend.block", u),
            unblock: (u) => mutate("friend.unblock", u),
            onUpdate(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });
        return undefined;
    },
};
