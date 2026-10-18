export interface MessageQuote {
    sender: string;
    content: string;
}

export type MessageKind =
    | "text"
    | "image"
    | "audio"
    | "video"
    | "file"
    | "merge"
    | "moment"
    | "redpacket"
    | "transfer"
    | "aabill"
    | "system"
    | "notice";

export interface MergedChat {
    sender: string;
    content: string;
    kind?: MessageKind;
    file?: FileMeta | null;
    link?: LinkPreview | null;
    merge?: MergePayload | null;
    createdAt: string;
}

export interface MergePayload {
    merge: 1;
    title: string;
    list: MergedChat[];
}

export const MENTION_ALL = "@all";
export const MENTION_ALL_LABEL = "全体成员";

export interface FileMeta {
    name: string;
    size: number;
    mime?: string;
}

export interface ChatMessage {
    id: string;
    session: string;
    sender: string;
    content: string;
    createdAt: string;
    recalledAt?: string | null;
    quote?: MessageQuote | null;
    mentions?: string[] | null;
    kind?: MessageKind;
    file?: FileMeta | null;
    link?: LinkPreview | null;
    reactions?: MessageReactions | null;

    redPacket?: RedPacketInfo | null;
    transfer?: TransferInfo | null;
    aaBill?: AABillInfo | null;
}

export type MessageReactions = Record<string, string[]>;

export const REACTION_EMOJIS = [
    "👍",
    "😂",
    "❤️",
    "🎉",
    "😮",
    "😢",
    "😡",
    "🙏",
] as const;

export interface User {
    id: string;
    username: string;
    createdAt: string;
    deptId?: string | null;
    title?: string | null;
    mustChangePassword?: boolean;
}

export interface DepartmentInfo {
    id: string;
    name: string;
    parentId: string | null;
    sort: number;
    groupId: string | null;
    memberCount: number;
    createdAt: string;
}

export interface DirectoryMember {
    id: string;
    username: string;
    deptId: string | null;
    title: string | null;
    createdAt: string;
    online: boolean;
}

export interface DirectoryResult {
    departments: DepartmentInfo[];
    members: DirectoryMember[];
}

export interface AuditEntry {
    id: string;
    actorId: string | null;
    actor: string;
    action: string;
    detail: string;
    createdAt: string;
}

export interface AuditListResult {
    rows: AuditEntry[];
    total: number;
}

export interface AuthSuccess {
    token: string;
    user: User;
}

export interface CredentialsParams {
    username: string;
    password: string;
}

export interface FriendGroupInfo {
    id: string;
    name: string;
}

export interface FriendListResult {
    friends: string[];
    incoming: string[];
    outgoing: string[];
    blocked: string[];
    remarks: Record<string, string>;
    groups: FriendGroupInfo[];
    friendGroups: Record<string, string | null>;
    starred: string[];
    incomingMessages?: Record<string, string>;
}

export type UserRelation =
    | "none"
    | "friend"
    | "outgoing"
    | "incoming"
    | "blocked";

export interface UserSearchHit {
    name: string;
    relation: UserRelation;
    title?: string | null;
}

export interface UserSearchResult {
    users: UserSearchHit[];
}

export interface StickerItem {
    url: string;
    name: string;
    mime: string;
    size: number;
}

export interface StickerListResult {
    stickers: StickerItem[];
}

export interface MessageRecalledEvent {
    id: string;
    session: string;
    recalledAt: string;
}

export type GroupRole = "owner" | "admin" | "member";

export interface GroupInfo {
    id: string;
    name: string;
    ownerId: string;
    notice: string;
    muteAll: boolean;
    noFriendAdd: boolean;
    inviteCode: string | null;
    inviteExpiresAt: string | null;
    joinApproval: boolean;
    pendingRequests: number;
    createdAt: string;
    memberCount: number;
    myRole: GroupRole | null;
    myMuted: boolean;
}

export interface GroupJoinRequest {
    username: string;
    message: string;
    createdAt: string;
}

export interface GroupJoinResult {
    status: "joined" | "pending";
    groupId: string;
    name: string;
}

export interface GroupRequestEvent {
    groupId: string;
    username: string;
}

export interface GroupMember {
    username: string;
    role: GroupRole;
    muted: boolean;
    joinedAt: string;
    title?: string | null;
}

export type PresenceStatus = "online" | "busy" | "away" | "dnd" | "invisible";

export interface PresenceUpdate {
    username: string;
    online: boolean;
    status?: PresenceStatus;
}

export interface PresenceListResult {
    online: string[];
    statuses: Record<string, PresenceStatus>;
}

export interface ReceiptUpdate {
    session: string;
    username: string;
    at: string;
}

export type ScreenSignalType =
    | "invite"
    | "accept"
    | "decline"
    | "hangup"
    | "timeout"
    | "offer"
    | "answer"
    | "ice";

export type CallKind = "screen" | "voice" | "video";

export interface ScreenSignal {
    type: ScreenSignalType;
    callId: string;
    from: string;
    kind?: CallKind;
    sdp?: string;
    candidate?: unknown;
}

export interface ScreenCallState {
    callId: string;
    kind: CallKind;
    peer: string;
    active: boolean;
    incoming: boolean;
}

export interface IceServerConfig {
    urls: string | string[];
    username?: string;
    credential?: string;
}

export interface GroupFileItem {
    key: string;
    name: string;
    mime: string;
    size: number;
    uploader: string;
    createdAt: string;
}

export interface GroupCallInfo {
    roomId: string;
    groupId: string;
    groupName: string;
    kind: CallKind;
    host: string;
    members: string[];
}

export type GroupCallEventType = "invite" | "join" | "leave" | "end";

export interface GroupCallEvent {
    type: GroupCallEventType;
    roomId: string;
    groupId: string;
    groupName: string;
    kind: CallKind;
    from: string;
}

export interface GroupCallSignal {
    type: "offer" | "answer" | "ice";
    roomId: string;
    from: string;
    sdp?: string;
    candidate?: unknown;
}

export type ServerEventName =
    | "message:new"
    | "message:update"
    | "message:recalled"
    | "friend:update"
    | "group:update"
    | "group:request"
    | "presence:update"
    | "receipt:update"
    | "typing"
    | "screen:signal"
    | "group:call"
    | "group:call:signal"
    | "redpacket:update"
    | "transfer:update"
    | "aabill:update"
    | "moment:update";

export interface TypingEvent {
    session: string;
    username: string;
}

export interface ServerEvent<P = unknown> {
    kind: "event";
    name: ServerEventName;
    payload: P;
}

export interface RpcRequest {
    kind: "rpc";
    id: string;
    method: string;
    params: Record<string, unknown>;
}

export interface RpcOk {
    kind: "rpc:ok";
    id: string;
    result: unknown;
}

export interface RpcErr {
    kind: "rpc:err";
    id: string;
    message: string;
}

export type Envelope = ServerEvent | RpcRequest | RpcOk | RpcErr;

export interface SendMessageParams {
    session: string;
    content: string;
    quote?: MessageQuote | null;
    mentions?: string[] | null;
    kind?: MessageKind;
    file?: FileMeta | null;
}

export interface HistoryParams {
    session: string;
    limit?: number;
    before?: string;
    after?: string;
    beforeId?: string;
    afterId?: string;
}

export interface TypingParams {
    session: string;
}

export interface RecallParams {
    id: string;
}

export interface FriendTargetParams {
    username: string;
    message?: string | null;
}

export interface FriendRemarkParams {
    username: string;
    remark: string;
}

export interface FriendGroupParams {
    groupId?: string;
    name?: string;
}

export interface FriendGroupMoveParams {
    username: string;
    groupId: string | null;
}

export interface FriendStarParams {
    username: string;
    on: boolean;
}

export interface PresenceStatusSetParams {
    status: PresenceStatus;
}

export interface MessageReactParams {
    id: string;
    emoji: string;
}

export interface GroupMemberTitleParams {
    groupId: string;
    username: string;
    title: string;
}

export interface GroupEssenceParams {
    groupId: string;
    messageId: string;
    on: boolean;
}

export interface GroupEssenceItem {
    messageId: string;
    sender: string;
    content: string;
    kind: MessageKind | null;
    createdAt: string;
    setBy: string;
    setAt: string;
}

export interface ChatPokeParams {
    session: string;
    target?: string;
}

export interface UserInfoResult {
    username: string;
    createdAt: string;
}

export interface MessageSearchParams {
    keyword: string;
    session?: string;
    offset?: number;
    limit?: number;
}

export interface MessageSearchResult {
    hits: ChatMessage[];
    total: number;
}

export type MomentVisibility = "public" | "friends" | "partial" | "exclude";

export interface MomentLike {
    username: string;
    at: string;
}

export interface MomentComment {
    id: string;
    author: string;
    content: string;
    createdAt: string;
}

export interface LinkPreview {
    url: string;
    title: string;
    description: string;
    image: string | null;
    site: string;
}

export interface MomentPost {
    id: string;
    author: string;
    content: string;
    images: string[];
    video: string | null;
    link: LinkPreview | null;
    visibility: MomentVisibility;
    audience: string[];
    createdAt: string;
    likes: MomentLike[];
    comments: MomentComment[];
}

export interface LinkPreviewParams {
    url: string;
}

export interface MomentPublishParams {
    content: string;
    images?: string[] | null;
    video?: string | null;
    link?: string | null;
    visibility?: MomentVisibility;
    audience?: string[] | null;
}

export interface MomentTimelineParams {
    author?: string;
    limit?: number;
    before?: string;
    beforeId?: string;
}

export interface MomentTimelineResult {
    posts: MomentPost[];
    hasMore: boolean;
}

export interface MomentTargetParams {
    postId: string;
}

export interface MomentShare {
    moment: 1;
    postId: string;
    author: string;
    text: string;
    image: string | null;
    video: string | null;
}

export interface MomentForwardParams {
    postId: string;
    sessions: string[];
}

export interface MomentLikeParams {
    postId: string;
    liked: boolean;
}

export interface MomentCommentParams {
    postId: string;
    content: string;
}

export interface MomentCommentDeleteParams {
    postId: string;
    commentId: string;
}

export type MomentAction =
    | "publish"
    | "delete"
    | "like"
    | "comment"
    | "commentDelete";

export interface MomentUpdateEvent {
    action: MomentAction;
    postId: string;
    author: string;
    owner: string;
}

export interface MomentUnreadResult {
    posts: number;
    interactions: number;
    total: number;
}

export interface RedPacketInfo {
    id: string;
    senderId: string;
    sessionId: string;
    type: "normal" | "lucky";
    totalAmount: number;
    totalCount: number;
    status: "active" | "exhausted" | "expired";
    remaining: number;
    remainCount: number;
    message?: string | null;
    createdAt: string;
    expiredAt?: string | null;
}

export interface RedPacketSummary {
    id: string;
    sessionId: string;
    senderId: string;
    type: "normal" | "lucky";
    totalAmount: number;
    totalCount: number;
    remaining: number;
    remainCount: number;
    status: "active" | "exhausted" | "expired";
    message?: string | null;
    createdAt: string;
    claimedCount: number;
    myAmount?: number | null;
}

export interface RedPacketDetail {
    packet: RedPacketSummary;
    bestClaimerId: string | null;
    records: {
        userId: string;
        username: string;
        amount: number;
        claimedAt: string;
        isMe?: boolean;
        isBest?: boolean;
    }[];
}

export interface RedPacketRecord {
    id: string;
    redPacketId: string;
    claimerId: string;
    amount: number;
    claimedAt: string;
}

export interface AABill {
    id: string;
    creatorId: string;
    sessionId: string;
    description: string;
    totalAmount: number;
    settledAmount: number;
    participantIds: string[];
    splitType: "equal" | "custom";
    customSplits?: Record<string, number>;
    deadline: string;
    status: "pending" | "settled" | "cancelled";
    createdAt: string;
}

export interface AABillInfo {
    id: string;
    sessionId: string;
    creatorId: string;
    description: string;
    totalAmount: number;
    settledAmount: number;
    participantIds: string[];
    splitType: "equal" | "custom";
    status: "pending" | "settled" | "cancelled";
    createdAt: string;
    deadline: string;
}

export interface AAPayment {
    id: string;
    billId: string;
    payerId: string;
    amount: number;
    paidAt: string;
}

export interface TransferInfo {
    id: string;
    fromId: string;
    toId: string;
    amount: number;
    message?: string;
    state: "pending" | "accepted" | "rejected" | "refunded";
    createdAt: string;
    expiredAt: string;
}

export interface TransferSummary extends TransferInfo {
    sessionId: string;
    myId: string;
    fromName: string;
    toName: string;
    action: "sent" | "received";
}

export interface AABillDetail {
    bill: AABill;
    share: number;
    paidAmount: number;
    paid: boolean;
    overdue: boolean;
    creatorName: string;
    payments: {
        userId: string;
        username: string;
        amount: number;
        paidAt: string;
    }[];
    members: {
        userId: string;
        username: string;
        share: number;
        paidAmount: number;
        paid: boolean;
    }[];
}

export interface RedPacketCreateParams {
    sessionId: string;
    type: "normal" | "lucky";
    totalAmount: number;
    totalCount: number;
    message?: string;
}

export interface RedPacketClaimParams {
    redPacketId: string;
}

export interface RedPacketDetailParams {
    redPacketId: string;
}

export interface RedPacketRecordsParams {
    redPacketId: string;
}

export interface AABillCreateParams {
    sessionId: string;
    description: string;
    totalAmount: number;
    participantIds?: string[];
    splitType: "equal" | "custom";
    customSplits?: Record<string, number>;
}

export interface AAPayBillParams {
    billId: string;
    amount: number;
}

export interface TransferSendParams {
    sessionId: string;
    toUsername: string;
    amount: number;
    message?: string;
}

export interface TransferActionParams {
    transferId: string;
}

export interface AABillDetailParams {
    billId: string;
}

export interface TransferCreateParams {
    targetUserId: string;
    amount: number;
    message?: string;
}

export interface TransferAcceptParams {
    transferId: string;
}

export interface TransferRejectParams {
    transferId: string;
    reason?: string;
}
