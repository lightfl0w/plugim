import type { Plugin } from "@plugim/core";
import type { FriendListResult } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface FriendsService {
    list(): Promise<FriendListResult>;
    request(username: string): Promise<FriendListResult>;
    accept(username: string): Promise<FriendListResult>;
    reject(username: string): Promise<FriendListResult>;
    remove(username: string): Promise<FriendListResult>;
    block(username: string): Promise<FriendListResult>;
    unblock(username: string): Promise<FriendListResult>;
    onUpdate(cb: () => void): () => void;
}

export const friendsPlugin: Plugin = {
    name: "friends",
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");

        const call = (method: string, username: string) =>
            rpc.call(method, { username }) as Promise<FriendListResult>;

        ctx.provide<FriendsService>("friends", {
            list: () =>
                rpc.call("friend.list", {}) as Promise<FriendListResult>,
            request: (username) => call("friend.request", username),
            accept: (username) => call("friend.accept", username),
            reject: (username) => call("friend.reject", username),
            remove: (username) => call("friend.remove", username),
            block: (username) => call("friend.block", username),
            unblock: (username) => call("friend.unblock", username),
            onUpdate(cb) {
                return ctx.on("server:friend:update", () => cb());
            },
        });
        return undefined;
    },
};
