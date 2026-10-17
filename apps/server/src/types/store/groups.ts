import type { GroupRole } from "@plugim/protocol";
import type { GroupMemberRow, GroupRow, JoinRequestRow } from "../row/groups";

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
    setMemberTitle(
        groupId: string,
        userId: string,
        title: string | null,
    ): Promise<void>;
    membersOf(groupId: string): Promise<GroupMemberRow[]>;
    memberIdsOf(groupId: string): Promise<string[]>;
    groupsOf(userId: string): Promise<GroupRow[]>;
    listAll(): Promise<(GroupRow & { memberCount: number })[]>;
    friendAddBlocked(aId: string, bId: string): Promise<boolean>;
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

export interface GroupFilesStore {
    save(row: import("../row/groups").GroupFileRow): Promise<void>;
    byKey(
        groupId: string,
        key: string,
    ): Promise<import("../row/groups").GroupFileRow | null>;
    list(
        groupId: string,
        params: { offset: number; limit: number },
    ): Promise<{ rows: import("../row/groups").GroupFileRow[]; total: number }>;
    countByKey(key: string): Promise<number>;
    remove(groupId: string, key: string): Promise<void>;
}

export interface EssencesStore {
    add(groupId: string, messageId: string, setBy: string): Promise<void>;
    remove(groupId: string, messageId: string): Promise<void>;
    has(groupId: string, messageId: string): Promise<boolean>;
    listOf(groupId: string): Promise<import("../row/groups").EssenceItemRow[]>;
}
