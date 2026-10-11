import type { LinkPreview, MomentVisibility } from "@plugim/protocol";

export interface MomentRow {
    id: string;
    authorId: string;
    content: string;
    images: string[];
    video: string | null;
    link: LinkPreview | null;
    visibility: MomentVisibility;
    audience: string[];
    createdAt: string;
}

export interface MomentLikeRow {
    postId: string;
    userId: string;
    at: string;
}

export interface MomentCommentRow {
    id: string;
    postId: string;
    authorId: string;
    content: string;
    createdAt: string;
}

export interface MomentUnreadRow {
    posts: number;
    interactions: number;
}
