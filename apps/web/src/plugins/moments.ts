import type { Plugin } from "@plugim/core";
import type {
    LinkPreview,
    MomentPost,
    MomentTimelineResult,
    MomentUnreadResult,
    MomentUpdateEvent,
    MomentVisibility,
} from "@plugim/protocol";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";

export interface MomentsState {
    posts: MomentPost[];
    hasMore: boolean;
    loading: boolean;
    error: string | null;
    author: string | null;
    unread: MomentUnreadResult;
}

export interface MomentsService {
    state(): MomentsState;
    setAuthor(author: string | null): void;
    setViewing(viewing: boolean): void;
    refresh(): Promise<void>;
    loadMore(): Promise<void>;
    publish(input: {
        content: string;
        images: string[];
        video: string | null;
        link: string | null;
        visibility: MomentVisibility;
        audience: string[];
    }): Promise<void>;
    preview(url: string): Promise<LinkPreview>;
    forward(postId: string, sessions: string[]): Promise<void>;
    like(postId: string, liked: boolean): Promise<void>;
    comment(postId: string, content: string): Promise<void>;
    remove(postId: string): Promise<void>;
    onUpdate(cb: () => void): () => void;
}

const PAGE = 10;

const EMPTY_UNREAD: MomentUnreadResult = {
    posts: 0,
    interactions: 0,
    total: 0,
};

export const momentsPlugin: Plugin = {
    name: "moments",
    description: "朋友圈动态状态",
    provides: ["moments"],
    inject: ["rpc", "auth"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const auth = ctx.get<AuthService>("auth");
        const listeners = new Set<() => void>();
        let state: MomentsState = {
            posts: [],
            hasMore: false,
            loading: false,
            error: null,
            author: null,
            unread: EMPTY_UNREAD,
        };
        let inflight: Promise<void> | null = null;
        let viewing = false;

        const set = (patch: Partial<MomentsState>) => {
            state = { ...state, ...patch };
            for (const cb of listeners) cb();
        };

        const pullUnread = async () => {
            const result = (await rpc.call(
                "moment.unread",
                {},
            )) as MomentUnreadResult;
            set({ unread: result });
        };

        const markSeen = async () => {
            const result = (await rpc.call(
                "moment.seen",
                {},
            )) as MomentUnreadResult;
            set({ unread: result });
        };

        const syncUnread = () =>
            void (viewing ? markSeen() : pullUnread()).catch(() => undefined);

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
            setViewing(next) {
                viewing = next;
                syncUnread();
            },
            refresh: () => run(false),
            loadMore: () => run(true),
            async publish(input) {
                const post = (await rpc.call("moment.publish", {
                    content: input.content,
                    images: input.images,
                    video: input.video,
                    link: input.link,
                    visibility: input.visibility,
                    audience: input.audience,
                })) as MomentPost;
                upsert(post);
            },
            preview: (url) =>
                rpc.call("moment.link", { url }) as Promise<LinkPreview>,
            async forward(postId, sessions) {
                await rpc.call("moment.forward", { postId, sessions });
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

        const notifyMomentUpdate = (payload: unknown) => {
            const event = payload as MomentUpdateEvent;
            if (event.action !== "like" && event.action !== "comment") return;
            const me = auth.user()?.username ?? "";
            if (!me || event.owner !== me || event.author === me) return;
            if (
                typeof document === "undefined" ||
                document.visibilityState !== "hidden"
            )
                return;
            if (
                typeof Notification === "undefined" ||
                Notification.permission !== "granted"
            )
                return;
            try {
                const notification = new Notification("朋友圈", {
                    body: `${event.author} ${event.action === "like" ? "赞了" : "评论了"}你的动态`,
                    tag: `moment-${event.postId}`,
                });
                notification.onclick = () => {
                    window.focus();
                    ctx.emit("ui:moments:open");
                };
            } catch {
                void 0;
            }
        };

        const disposeEvent = ctx.on("server:moment:update", (payload) => {
            notifyMomentUpdate(payload);
            void run(false);
            syncUnread();
        });
        const onVisibility = () => {
            if (document.visibilityState === "visible") syncUnread();
        };
        const hasDocument = typeof document !== "undefined";
        if (hasDocument)
            document.addEventListener("visibilitychange", onVisibility);
        const onStatus = (status: string) => {
            if (status !== "open") return;
            void run(false);
            syncUnread();
        };
        if (rpc.status() === "open") {
            void run(false);
            syncUnread();
        }
        const unstatus = rpc.onStatus(onStatus);

        return () => {
            disposeEvent();
            unstatus();
            if (hasDocument)
                document.removeEventListener("visibilitychange", onVisibility);
        };
    },
};
