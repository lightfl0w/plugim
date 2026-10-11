import type { ChatMessage, LinkPreview } from "@plugim/protocol";
import type { AuthUser, ChatSendPayload } from "../shared";

export interface AuthService {
    verifyToken(token: string | null): Promise<AuthUser | null>;
    requireUser(conn: import("./gateway").ConnInfo): AuthUser;
}

export interface ChatService {
    sendTo(
        user: AuthUser,
        session: string,
        payload: ChatSendPayload,
    ): Promise<ChatMessage>;
}

export interface GroupAclService {
    requireMembership(
        groupId: string,
        me: AuthUser,
    ): Promise<{ row: import("../row/groups").GroupRow; members: import("../row/groups").GroupMemberRow[]; mine: import("@plugim/protocol").GroupRole }>;
    sessionOf(groupId: string): string;
}

export interface LinkPreviewService {
    preview(rawUrl: unknown): Promise<LinkPreview>;
    previewOfText(content: string): Promise<LinkPreview | null>;
    clear(): void;
}
