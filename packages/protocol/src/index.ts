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
    | "system"
    | "notice";

export interface MergedChat {
    sender: string;
    content: string;
    kind?: MessageKind;
    link?: LinkPreview | null;
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

export type PresenceStatus =
    | "online"
    | "busy"
    | "away"
    | "dnd"
    | "invisible";

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

export type MomentAction = "publish" | "delete" | "like" | "comment";

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
