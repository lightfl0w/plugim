import type { Plugin } from "@plugim/core";
import type { GroupInfo, GroupMember, GroupRole } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    GatewayService,
    GroupRow,
    GroupsStore,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const sessionOf = (groupId: string) => `g:${groupId}`;

export const groupPlugin: Plugin = {
    name: "group",
    description: "群组管理 RPC",
    provides: ["group-rpc"],
    inject: ["gateway", "groups", "accounts"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const groups = ctx.get<GroupsStore>("groups");
        const accounts = ctx.get<AccountsStore>("accounts");

        const memberNames = async (
            memberIds: string[],
        ): Promise<Map<string, string>> => {
            const users = await accounts.byIds([...new Set(memberIds)]);
            return new Map(users.map((u) => [u.id, u.username]));
        };

        const infoOf = async (
            row: GroupRow,
            meId: string,
        ): Promise<GroupInfo> => {
            const members = await groups.membersOf(row.id);
            return {
                id: row.id,
                name: row.name,
                ownerId: row.ownerId,
                notice: row.notice,
                muteAll: row.muteAll,
                noFriendAdd: row.noFriendAdd,
                createdAt: row.createdAt,
                memberCount: members.length,
                myRole: members.find((m) => m.userId === meId)?.role ?? null,
            };
        };

        const requireMembership = async (groupId: string, me: AuthUser) => {
            const row = await groups.byId(groupId);
            if (!row) throw new Error("群组不存在");
            const members = await groups.membersOf(groupId);
            const mine = members.find((m) => m.userId === me.id);
            if (!mine) throw new Error("你不在该群中");
            return { row, members, mine: mine.role };
        };

        const requireManage = async (groupId: string, me: AuthUser) => {
            const state = await requireMembership(groupId, me);
            if (state.mine !== "owner" && state.mine !== "admin")
                throw new Error("需要群主或管理员权限");
            return state;
        };

        const notifyMembers = async (groupId: string) => {
            const ids = await groups.memberIdsOf(groupId);
            for (const id of ids)
                gateway.emitToUser(id, "group:update", { groupId });
        };

        gateway.rpc("group.create", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as {
                name?: string;
                members?: string[];
            };
            const name = String(params.name ?? "")
                .trim()
                .slice(0, 32);
            if (name.length < 2) throw new Error("群名称至少 2 个字符");
            const row = await groups.create(name, me.id);
            await groups.addMember(row.id, me.id);
            await groups.setRole(row.id, me.id, "owner");
            for (const username of (params.members ?? []).slice(0, 200)) {
                const user = await accounts.byUsername(
                    String(username).toLowerCase(),
                );
                if (user && user.id !== me.id)
                    await groups.addMember(row.id, user.id);
            }
            await notifyMembers(row.id);
            return infoOf(row, me.id);
        });

        gateway.rpc("group.list", async (_raw, conn) => {
            const me = requireUser(conn);
            const rows = await groups.groupsOf(me.id);
            const infos: GroupInfo[] = [];
            for (const row of rows) infos.push(await infoOf(row, me.id));
            return infos;
        });

        gateway.rpc("group.info", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId } = raw as unknown as { groupId: string };
            const { row } = await requireMembership(groupId, me);
            return infoOf(row, me.id);
        });

        gateway.rpc("group.members", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId } = raw as unknown as { groupId: string };
            const { members } = await requireMembership(groupId, me);
            const names = await memberNames(members.map((m) => m.userId));
            const online = new Set(gateway.onlineUserIds());
            const result: GroupMember[] = members
                .map((m) => ({
                    username: names.get(m.userId) ?? m.userId,
                    role: m.role,
                    muted: m.muted,
                    joinedAt: m.joinedAt,
                }))
                .sort(
                    (a, b) =>
                        Number(b.role === "owner") -
                            Number(a.role === "owner") ||
                        Number(b.role === "admin") -
                            Number(a.role === "admin") ||
                        a.username.localeCompare(b.username),
                );
            return { members: result, online: online.size };
        });

        gateway.rpc("group.rename", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, name } = raw as unknown as {
                groupId: string;
                name: string;
            };
            const { row } = await requireManage(groupId, me);
            const clean = String(name ?? "")
                .trim()
                .slice(0, 32);
            if (clean.length < 2) throw new Error("群名称至少 2 个字符");
            await groups.rename(groupId, clean);
            await notifyMembers(groupId);
            return infoOf({ ...row, name: clean }, me.id);
        });

        gateway.rpc("group.notice.set", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, notice } = raw as unknown as {
                groupId: string;
                notice: string;
            };
            const { row } = await requireManage(groupId, me);
            const clean = String(notice ?? "")
                .trim()
                .slice(0, 500);
            await groups.setNotice(groupId, clean);
            await notifyMembers(groupId);
            return infoOf({ ...row, notice: clean }, me.id);
        });

        gateway.rpc("group.muteAll", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, on } = raw as unknown as {
                groupId: string;
                on: boolean;
            };
            const { row } = await requireManage(groupId, me);
            await groups.setMuteAll(groupId, !!on);
            await notifyMembers(groupId);
            return infoOf({ ...row, muteAll: !!on }, me.id);
        });

        gateway.rpc("group.noFriendAdd", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, on } = raw as unknown as {
                groupId: string;
                on: boolean;
            };
            const { row } = await requireManage(groupId, me);
            await groups.setNoFriendAdd(groupId, !!on);
            await notifyMembers(groupId);
            return infoOf({ ...row, noFriendAdd: !!on }, me.id);
        });

        gateway.rpc("group.member.add", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, usernames } = raw as unknown as {
                groupId: string;
                usernames: string[];
            };
            await requireManage(groupId, me);
            for (const username of (usernames ?? []).slice(0, 100)) {
                const user = await accounts.byUsername(
                    String(username).toLowerCase(),
                );
                if (!user) throw new Error(`用户 ${username} 不存在`);
                await groups.addMember(groupId, user.id);
            }
            await notifyMembers(groupId);
            return (await groups.byId(groupId)) !== null;
        });

        gateway.rpc("group.member.remove", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, username } = raw as unknown as {
                groupId: string;
                username: string;
            };
            const { row, mine } = await requireMembership(groupId, me);
            const targetUser = await accounts.byUsername(
                String(username).toLowerCase(),
            );
            if (!targetUser) throw new Error("用户不存在");
            if (targetUser.id === row.ownerId) throw new Error("不能移除群主");
            if (targetUser.id === me.id) {
                await groups.removeMember(groupId, me.id);
                await notifyMembers(groupId);
                return true;
            }
            if (mine === "member") throw new Error("只有管理员可以移除成员");
            await groups.removeMember(groupId, targetUser.id);
            await notifyMembers(groupId);
            return true;
        });

        gateway.rpc("group.member.role", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, username, role } = raw as unknown as {
                groupId: string;
                username: string;
                role: GroupRole;
            };
            const { row, mine: myRole } = await requireMembership(groupId, me);
            if (myRole !== "owner") throw new Error("只有群主可以调整角色");
            if (role !== "admin" && role !== "member")
                throw new Error("非法角色");
            const target = await accounts.byUsername(
                String(username).toLowerCase(),
            );
            if (!target) throw new Error("用户不存在");
            if (target.id === row.ownerId) throw new Error("不能调整群主角色");
            await groups.setRole(groupId, target.id, role);
            await notifyMembers(groupId);
            return true;
        });

        gateway.rpc("group.member.mute", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, username, muted } = raw as unknown as {
                groupId: string;
                username: string;
                muted: boolean;
            };
            const { members, mine: myRole } = await requireMembership(
                groupId,
                me,
            );
            if (myRole === "member") throw new Error("没有权限");
            const target = await accounts.byUsername(
                String(username).toLowerCase(),
            );
            if (!target) throw new Error("用户不存在");
            const targetMember = members.find((m) => m.userId === target.id);
            if (!targetMember) throw new Error("该用户不在群中");
            if (targetMember.role !== "member")
                throw new Error("不能禁言管理员或群主");
            await groups.setMuted(groupId, target.id, !!muted);
            await notifyMembers(groupId);
            return true;
        });

        gateway.rpc("group.delete", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId } = raw as unknown as { groupId: string };
            const { row } = await requireMembership(groupId, me);
            if (row.ownerId !== me.id) throw new Error("只有群主可以解散群");
            await notifyMembers(groupId);
            await groups.remove(groupId);
            return true;
        });

        gateway.rpc("group.leave", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId } = raw as unknown as { groupId: string };
            const { row } = await requireMembership(groupId, me);
            if (row.ownerId === me.id)
                throw new Error("群主请先解散群或转让群主");
            await groups.removeMember(groupId, me.id);
            await notifyMembers(groupId);
            return true;
        });

        ctx.provide("group-acl", {
            requireMembership,
            sessionOf,
        });
        return undefined;
    },
};
