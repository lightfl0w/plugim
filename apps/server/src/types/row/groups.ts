import type { GroupRole } from "@plugim/protocol";

export interface GroupRow {
    id: string;
    name: string;
    ownerId: string;
    notice: string;
    muteAll: boolean;
    noFriendAdd: boolean;
    inviteCode: string | null;
    inviteExpiresAt: string | null;
    joinApproval: boolean;
    createdAt: string;
}

export interface GroupMemberRow {
    userId: string;
    role: GroupRole;
    muted: boolean;
    joinedAt: string;
    title: string | null;
}

export interface JoinRequestRow {
    groupId: string;
    userId: string;
    message: string;
    createdAt: string;
}

export interface GroupFileRow {
    groupId: string;
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderId: string;
    createdAt: string;
}

export interface EssenceItemRow {
    messageId: string;
    sender: string;
    content: string;
    kind: string | null;
    createdAt: string;
    setBy: string;
    setAt: string;
}
