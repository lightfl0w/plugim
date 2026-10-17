import type {
    MomentCommentRow,
    MomentLikeRow,
    MomentRow,
    MomentUnreadRow,
} from "../row/moments";

export interface MomentsStore {
    create(input: {
        authorId: string;
        content: string;
        images: string[];
        video: string | null;
        link: import("@plugim/protocol").LinkPreview | null;
        visibility: import("@plugim/protocol").MomentVisibility;
        audience: string[];
    }): Promise<MomentRow>;

    byId(id: string): Promise<MomentRow | null>;
    remove(id: string): Promise<void>;

    list(params: {
        viewerId: string;
        friendIds: string[];
        author?: string;
        before?: string;
        beforeId?: string;
        limit: number;
    }): Promise<MomentRow[]>;

    audienceOf(postId: string): Promise<string[]>;
    unread(userId: string, friendIds: string[]): Promise<MomentUnreadRow>;
    markSeen(userId: string, at: string): Promise<void>;
    setLike(postId: string, userId: string, liked: boolean): Promise<void>;
    likesOf(postIds: string[]): Promise<MomentLikeRow[]>;
    addComment(input: {
        postId: string;
        authorId: string;
        content: string;
    }): Promise<MomentCommentRow>;
    commentsOf(postIds: string[]): Promise<MomentCommentRow[]>;
}
