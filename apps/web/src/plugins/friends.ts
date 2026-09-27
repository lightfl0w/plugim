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
    remarkOf(username: string): string | null;
    setRemark(username: string, remark: string): Promise<void>;
    groupCreate(name: string): Promise<FriendListResult>;
    groupRename(groupId: string, name: string): Promise<FriendListResult>;
    groupRemove(groupId: string): Promise<FriendListResult>;
    groupMove(
        username: string,
        groupId: string | null,
    ): Promise<FriendListResult>;
    onUpdate(cb: () => void): () => void;
}

export const friendsPlugin: Plugin = {
    name: "friends",
    description: "好友列表与关系操作",
    provides: ["friends"],
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

        const disposeUpdate = ctx.on("server:friend:update", () => {
            void fetchList().catch(() => undefined);
        });

        const refreshOnOpen = (status: string) => {
            if (status === "open") void fetchList().catch(() => undefined);
        };
        if (rpc.status() === "open") void fetchList().catch(() => undefined);
        const unstatus = rpc.onStatus(refreshOnOpen);

        ctx.provide<FriendsService>("friends", {
            cached: () => cache,
            refresh: fetchList,
            request: (u) => mutate("friend.request", u),
            accept: (u) => mutate("friend.accept", u),
            reject: (u) => mutate("friend.reject", u),
            remove: (u) => mutate("friend.remove", u),
            block: (u) => mutate("friend.block", u),
            unblock: (u) => mutate("friend.unblock", u),
            remarkOf: (username) => cache?.remarks?.[username] ?? null,
            setRemark: (username, remark) =>
                rpc
                    .call("friend.remark", { username, remark })
                    .then((result) => {
                        cache = result as FriendListResult;
                        emit();
                    }),
            groupCreate: (name) =>
                rpc.call("friend.group.create", { name }).then((result) => {
                    cache = result as FriendListResult;
                    emit();
                    return cache;
                }),
            groupRename: (groupId, name) =>
                rpc
                    .call("friend.group.rename", { groupId, name })
                    .then((result) => {
                        cache = result as FriendListResult;
                        emit();
                        return cache;
                    }),
            groupRemove: (groupId) =>
                rpc.call("friend.group.remove", { groupId }).then((result) => {
                    cache = result as FriendListResult;
                    emit();
                    return cache;
                }),
            groupMove: (username, groupId) =>
                rpc
                    .call("friend.group.move", { username, groupId })
                    .then((result) => {
                        cache = result as FriendListResult;
                        emit();
                        return cache;
                    }),
            onUpdate(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });
        return () => {
            disposeUpdate();
            unstatus();
        };
    },
};
