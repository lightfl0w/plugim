import type { FriendStatus } from "../shared";

export interface FriendEdge {
    requesterId: string;
    addresseeId: string;
    status: FriendStatus;
    createdAt: string;
}

export interface FriendGroupRow {
    id: string;
    ownerId: string;
    name: string;
    createdAt: string;
}

export interface FriendsStore {
    request(requesterId: string, addresseeId: string): Promise<void>;
    accept(requesterId: string, addresseeId: string): Promise<void>;
    removeBetween(aId: string, bId: string): Promise<void>;
    block(blockerId: string, targetId: string): Promise<void>;
    unblock(blockerId: string, targetId: string): Promise<void>;
    edgesOf(userId: string): Promise<FriendEdge[]>;
    setRemark(ownerId: string, friendId: string, remark: string): Promise<void>;
    remarksOf(ownerId: string): Promise<Record<string, string>>;
    starsOf(ownerId: string): Promise<string[]>;
    setStar(ownerId: string, friendId: string, on: boolean): Promise<void>;
    groupListOf(ownerId: string): Promise<FriendGroupRow[]>;
    groupCreate(ownerId: string, name: string): Promise<FriendGroupRow>;
    groupRename(ownerId: string, groupId: string, name: string): Promise<void>;
    groupRemove(ownerId: string, groupId: string): Promise<void>;
    groupSetFriend(
        ownerId: string,
        friendId: string,
        groupId: string | null,
    ): Promise<void>;
    friendGroupMap(ownerId: string): Promise<Record<string, string>>;
}
