import type { Plugin } from "@plugim/core";
import type {
    MomentPost,
    MomentTimelineResult,
    MomentVisibility,
} from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface MomentsState {
    posts: MomentPost[];
    hasMore: boolean;
    loading: boolean;
    error: string | null;
    author: string | null;
}

export interface MomentsService {
    state(): MomentsState;
    setAuthor(author: string | null): void;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
    publish(input: {
        content: string;
        images: string[];
        visibility: MomentVisibility;
    }): Promise<void>;
    like(postId: string, liked: boolean): Promise<void>;
    comment(postId: string, content: string): Promise<void>;
    remove(postId: string): Promise<void>;
    onUpdate(cb: () => void): () => void;
}

const PAGE = 10;

export const momentsPlugin: Plugin = {
    name: "moments",
    description: "朋友圈动态状态",
    provides: ["moments"],
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const listeners = new Set<() => void>();
        let state: MomentsState = {
            posts: [],
            hasMore: false,
            loading: false,
            error: null,
            author: null,
        };
        let inflight: Promise<void> | null = null;

        const set = (patch: Partial<MomentsState>) => {
            state = { ...state, ...patch };
            for (const cb of listeners) cb();
        };

        const fetchPage = async (append: boolean) => {
            const params: Record<string, unknown> = {
                limit: append ? PAGE : Math.max(PAGE, state.posts.length),
            };
            if (state.author) params.author = state.author;
            const last = append ? state.posts[state.posts.length - 1] : null;
            if (last) {
                params.before = last.createdAt;
                params.beforeId = last.id;
            }
            const result = (await rpc.call(
                "moment.timeline",
                params,
            )) as MomentTimelineResult;
            if (!append) {
                set({ posts: result.posts, hasMore: result.hasMore });
                return;
            }
            const seen = new Set(state.posts.map((post) => post.id));
            set({
                posts: [
                    ...state.posts,
                    ...result.posts.filter((post) => !seen.has(post.id)),
                ],
                hasMore: result.hasMore,
            });
        };

        const run = (append: boolean) => {
            if (inflight) return inflight;
            set({ loading: true, error: null });
            inflight = fetchPage(append)
                .catch((err) => {
                    set({
                        error: err instanceof Error ? err.message : String(err),
                    });
                })
                .finally(() => {
                    inflight = null;
                    set({ loading: false });
                });
            return inflight;
        };

        const upsert = (post: MomentPost) => {
            if (state.posts.some((item) => item.id === post.id)) {
                set({
                    posts: state.posts.map((item) =>
                        item.id === post.id ? post : item,
                    ),
                });
                return;
            }
            if (!state.author || state.author === post.author)
                set({ posts: [post, ...state.posts] });
        };

        ctx.provide<MomentsService>("moments", {
            state: () => state,
            setAuthor(author) {
                if (state.author === author) return;
                set({
                    author,
                    posts: [],
                    hasMore: false,
                    error: null,
                });
                void run(false);
            },
            refresh: () => run(false),
            loadMore: () => run(true),
            async publish(input) {
                const post = (await rpc.call("moment.publish", {
                    content: input.content,
                    images: input.images,
                    visibility: input.visibility,
                })) as MomentPost;
                upsert(post);
            },
            async like(postId, liked) {
                const post = (await rpc.call("moment.like", {
                    postId,
                    liked,
                })) as MomentPost;
                upsert(post);
            },
            async comment(postId, content) {
                const post = (await rpc.call("moment.comment", {
                    postId,
                    content,
                })) as MomentPost;
                upsert(post);
            },
            async remove(postId) {
                await rpc.call("moment.delete", { postId });
                set({
                    posts: state.posts.filter((post) => post.id !== postId),
                });
            },
            onUpdate(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });

        const disposeEvent = ctx.on("server:moment:update", () => {
            void run(false);
        });
        const onStatus = (status: string) => {
            if (status === "open") void run(false);
        };
        if (rpc.status() === "open") void run(false);
        const unstatus = rpc.onStatus(onStatus);

        return () => {
            disposeEvent();
            unstatus();
        };
    },
};
