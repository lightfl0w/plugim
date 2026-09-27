import type { Plugin } from "@plugim/core";
import type {
    FriendGroupMoveParams,
    FriendGroupParams,
    FriendListResult,
    FriendRemarkParams,
    FriendTargetParams,
} from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
    GroupsStore,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const requireParams = (raw: unknown): FriendTargetParams =>
    raw as unknown as FriendTargetParams;

export const friendsPlugin: Plugin = {
    name: "friends",
    description: "好友关系链 RPC",
    provides: ["friend-rpc"],
    inject: ["gateway", "store", "accounts", "groups"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const groups = ctx.get<GroupsStore>("groups");

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
                remarks: {},
                groups: [],
                friendGroups: {},
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
            for (const list of [
                result.friends,
                result.incoming,
                result.outgoing,
                result.blocked,
            ])
                list.sort();
            const remarks = await friendships.remarksOf(me.id);
            for (const [friendId, remark] of Object.entries(remarks)) {
                const name = nameById.get(friendId);
                if (name) result.remarks[name] = remark;
            }
            const groupRows = await friendships.groupListOf(me.id);
            result.groups = groupRows.map((row) => ({
                id: row.id,
                name: row.name,
            }));
            const groupMap = await friendships.friendGroupMap(me.id);
            for (const user of users)
                result.friendGroups[user.username] = groupMap[user.id] ?? null;
            return result;
        };

        gateway.rpc("friend.request", async (raw, conn) => {
            const me = requireUser(conn);
            const target = await usernameToUser(requireParams(raw).username);
            if (target.id === me.id) throw new Error("不能添加自己为好友");
            if (await groups.friendAddBlocked(me.id, target.id))
                throw new Error("对方所在的群设置了禁止互加好友");
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

        gateway.rpc("friend.remark", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as FriendRemarkParams;
            const target = await usernameToUser(String(params.username ?? ""));
            if (target.id === me.id) throw new Error("不能给自己设置备注");
            const edges = await friendships.edgesOf(me.id);
            const isFriend = edges.some(
                (edge) =>
                    edge.status === "accepted" &&
                    ((edge.requesterId === me.id &&
                        edge.addresseeId === target.id) ||
                        (edge.requesterId === target.id &&
                            edge.addresseeId === me.id)),
            );
            if (!isFriend) throw new Error("只能给好友设置备注");
            const remark =
                typeof params.remark === "string" ? params.remark.trim() : "";
            if (remark.length > 24) throw new Error("备注不能超过 24 个字");
            await friendships.setRemark(me.id, target.id, remark);
            return buildList(me);
        });

        gateway.rpc("friend.list", async (_raw, conn) =>
            buildList(requireUser(conn)),
        );

        const normalizeGroupName = (raw: unknown) => {
            const name = String(raw ?? "")
                .trim()
                .slice(0, 16);
            if (!name) throw new Error("分组名称不能为空");
            return name;
        };

        gateway.rpc("friend.group.create", async (raw, conn) => {
            const me = requireUser(conn);
            const name = normalizeGroupName(
                (raw as unknown as FriendGroupParams).name,
            );
            const rows = await friendships.groupListOf(me.id);
            if (rows.length >= 20) throw new Error("分组数量已达上限");
            if (rows.some((row) => row.name === name))
                throw new Error("分组名称已存在");
            await friendships.groupCreate(me.id, name);
            return buildList(me);
        });

        gateway.rpc("friend.group.rename", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as FriendGroupParams;
            if (!params.groupId) throw new Error("缺少分组");
            const name = normalizeGroupName(params.name);
            const rows = await friendships.groupListOf(me.id);
            if (!rows.some((row) => row.id === params.groupId))
                throw new Error("分组不存在");
            if (
                rows.some(
                    (row) => row.id !== params.groupId && row.name === name,
                )
            )
                throw new Error("分组名称已存在");
            await friendships.groupRename(me.id, params.groupId, name);
            return buildList(me);
        });

        gateway.rpc("friend.group.remove", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId } = raw as unknown as FriendGroupParams;
            if (!groupId) throw new Error("缺少分组");
            const rows = await friendships.groupListOf(me.id);
            if (!rows.some((row) => row.id === groupId))
                throw new Error("分组不存在");
            await friendships.groupRemove(me.id, groupId);
            return buildList(me);
        });

        gateway.rpc("friend.group.move", async (raw, conn) => {
            const me = requireUser(conn);
            const { username, groupId } =
                raw as unknown as FriendGroupMoveParams;
            const target = await usernameToUser(String(username ?? ""));
            const edges = await friendships.edgesOf(me.id);
            const isFriend = edges.some(
                (edge) =>
                    edge.status === "accepted" &&
                    ((edge.requesterId === me.id &&
                        edge.addresseeId === target.id) ||
                        (edge.requesterId === target.id &&
                            edge.addresseeId === me.id)),
            );
            if (!isFriend) throw new Error("只能移动好友");
            if (groupId) {
                const rows = await friendships.groupListOf(me.id);
                if (!rows.some((row) => row.id === groupId))
                    throw new Error("分组不存在");
            }
            await friendships.groupSetFriend(me.id, target.id, groupId ?? null);
            return buildList(me);
        });
        return undefined;
    },
};
