import type { Plugin } from "@plugim/core";
import type { FriendListResult, FriendTargetParams } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const requireParams = (raw: unknown): FriendTargetParams =>
    raw as unknown as FriendTargetParams;

export const friendsPlugin: Plugin = {
    name: "friends",
    inject: ["gateway", "store", "accounts"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");

        const usernameToUser = async (username: string) => {
            const user = await accounts.byUsername(username.toLowerCase());
            if (!user) throw new Error(`用户 ${username} 不存在`);
            return user;
        };

        const notify = async (userId: string) => {
            gateway.emitToUser(userId, "friend:update", { at: Date.now() });
        };

        const buildList = async (me: AuthUser): Promise<FriendListResult> => {
            const edges = await friendships.edgesOf(me.id);
            const others = edges.map((edge) =>
                edge.requesterId === me.id
                    ? edge.addresseeId
                    : edge.requesterId,
            );
            const users = await accounts.byIds([...new Set(others)]);
            const nameById = new Map(
                users.map((user) => [user.id, user.username]),
            );
            const result: FriendListResult = {
                friends: [],
                incoming: [],
                outgoing: [],
                blocked: [],
            };
            for (const edge of edges) {
                const other =
                    edge.requesterId === me.id
                        ? edge.addresseeId
                        : edge.requesterId;
                const name = nameById.get(other);
                if (!name) continue;
                if (edge.status === "accepted") result.friends.push(name);
                else if (edge.status === "blocked") {
                    if (edge.requesterId === me.id) result.blocked.push(name);
                } else if (edge.requesterId === me.id)
                    result.outgoing.push(name);
                else result.incoming.push(name);
            }
            for (const key of Object.keys(result) as (keyof FriendListResult)[])
                result[key].sort();
            return result;
        };

        gateway.rpc("friend.request", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            if (target.id === me.id) throw new Error("不能添加自己为好友");
            const edges = await friendships.edgesOf(me.id);
            const existing = edges.find(
                (edge) =>
                    (edge.requesterId === target.id &&
                        edge.addresseeId === me.id) ||
                    (edge.requesterId === me.id &&
                        edge.addresseeId === target.id),
            );
            if (existing) {
                if (existing.status === "blocked")
                    throw new Error("当前无法发送好友申请");
                if (existing.status === "accepted")
                    throw new Error("你们已经是好友了");
                if (existing.requesterId === me.id)
                    throw new Error("已发送过好友申请，等待对方处理");
                await friendships.accept(me.id, target.id);
                await notify(target.id);
                return buildList(me);
            }
            await friendships.request(me.id, target.id);
            await notify(target.id);
            return buildList(me);
        });

        gateway.rpc("friend.accept", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            await friendships.accept(target.id, me.id);
            await notify(target.id);
            return buildList(me);
        });

        gateway.rpc("friend.reject", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            await friendships.removeBetween(me.id, target.id);
            return buildList(me);
        });

        gateway.rpc("friend.remove", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            await friendships.removeBetween(me.id, target.id);
            await notify(target.id);
            return buildList(me);
        });

        gateway.rpc("friend.block", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            await friendships.block(me.id, target.id);
            await notify(target.id);
            return buildList(me);
        });

        gateway.rpc("friend.unblock", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            await friendships.unblock(me.id, target.id);
            return buildList(me);
        });

        gateway.rpc("friend.list", async (_raw, conn) =>
            buildList(requireUser(conn)),
        );
        return undefined;
    },
};
