import type { Plugin } from "@plugim/core";
import type {
    MomentAction,
    MomentCommentParams,
    MomentLikeParams,
    MomentPost,
    MomentPublishParams,
    MomentTargetParams,
    MomentTimelineParams,
    MomentTimelineResult,
    MomentVisibility,
} from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ConnInfo,
    FriendsStore,
    GatewayService,
    MediaFilesStore,
    MomentRow,
    MomentsStore,
} from "../types";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const CONTENT_MAX = 1000;
const COMMENT_MAX = 300;
const IMAGES_MAX = 9;
const TIMELINE_MAX = 30;
const TIMELINE_DEFAULT = 10;
const KEY_MAX = 200;

const clampLimit = (value: unknown): number => {
    const num = Math.floor(Number(value));
    if (!Number.isFinite(num) || num <= 0) return TIMELINE_DEFAULT;
    return Math.min(num, TIMELINE_MAX);
};

export const momentsPlugin: Plugin = {
    name: "moments",
    description: "朋友圈动态、点赞与评论 RPC",
    provides: ["moment-rpc"],
    inject: ["gateway", "accounts", "friendships", "moments", "mediaFiles"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const store = ctx.get<MomentsStore>("moments");
        const mediaFiles = ctx.get<MediaFilesStore>("mediaFiles");

        const friendIdsOf = async (userId: string): Promise<string[]> => {
            const edges = await friendships.edgesOf(userId);
            return [
                ...new Set(
                    edges
                        .filter((edge) => edge.status === "accepted")
                        .map((edge) =>
                            edge.requesterId === userId
                                ? edge.addresseeId
                                : edge.requesterId,
                        ),
                ),
            ];
        };

        const build = async (rows: MomentRow[]): Promise<MomentPost[]> => {
            const ids = rows.map((row) => row.id);
            const [likes, comments] = await Promise.all([
                store.likesOf(ids),
                store.commentsOf(ids),
            ]);
            const users = await accounts.byIds([
                ...rows.map((row) => row.authorId),
                ...likes.map((like) => like.userId),
                ...comments.map((comment) => comment.authorId),
            ]);
            const nameById = new Map(
                users.map((user) => [user.id, user.username]),
            );
            return rows.map((row) => ({
                id: row.id,
                author: nameById.get(row.authorId) ?? "未知用户",
                content: row.content,
                images: row.images,
                visibility: row.visibility,
                createdAt: row.createdAt,
                likes: likes
                    .filter((like) => like.postId === row.id)
                    .map((like) => ({
                        username: nameById.get(like.userId) ?? "未知用户",
                        at: like.at,
                    })),
                comments: comments
                    .filter((comment) => comment.postId === row.id)
                    .map((comment) => ({
                        id: comment.id,
                        author: nameById.get(comment.authorId) ?? "未知用户",
                        content: comment.content,
                        createdAt: comment.createdAt,
                    })),
            }));
        };

        const buildOne = async (row: MomentRow): Promise<MomentPost> => {
            const [post] = await build([row]);
            return post;
        };

        const loadVisible = async (
            rawId: unknown,
            me: AuthUser,
        ): Promise<MomentRow> => {
            const postId = String(rawId ?? "").trim();
            if (!postId) throw new Error("动态不存在或已被删除");
            const row = await store.byId(postId);
            if (!row) throw new Error("动态不存在或已被删除");
            if (row.authorId === me.id || row.visibility === "public")
                return row;
            const friendIds = await friendIdsOf(me.id);
            if (friendIds.includes(row.authorId)) return row;
            throw new Error("无权查看该动态");
        };

        const notify = async (
            row: MomentRow,
            action: MomentAction,
            actor: AuthUser,
        ) => {
            const recipients = new Set([
                row.authorId,
                ...(await friendIdsOf(row.authorId)),
            ]);
            for (const id of recipients)
                gateway.emitToUser(id, "moment:update", {
                    action,
                    postId: row.id,
                    author: actor.username,
                });
        };

        gateway.rpc("moment.publish", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as MomentPublishParams;
            const content =
                typeof params.content === "string" ? params.content.trim() : "";
            if (content.length > CONTENT_MAX)
                throw new Error(`内容不能超过 ${CONTENT_MAX} 个字`);
            const keys = Array.isArray(params.images)
                ? [
                      ...new Set(
                          params.images
                              .filter(
                                  (key): key is string =>
                                      typeof key === "string",
                              )
                              .map((key) => key.trim())
                              .filter((key) => key && key.length <= KEY_MAX),
                      ),
                  ].slice(0, IMAGES_MAX)
                : [];
            if (!content && keys.length === 0)
                throw new Error("动态内容不能为空");
            for (const key of keys) {
                if (!(await mediaFiles.byKey(key)))
                    throw new Error("图片不存在或已被删除");
            }
            const visibility: MomentVisibility =
                params.visibility === "friends" ? "friends" : "public";
            const row = await store.create({
                authorId: me.id,
                content,
                images: keys,
                visibility,
            });
            await notify(row, "publish", me);
            return buildOne(row);
        });

        gateway.rpc("moment.timeline", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as MomentTimelineParams;
            const limit = clampLimit(params.limit);
            const friendIds = await friendIdsOf(me.id);
            const authorName =
                typeof params.author === "string" ? params.author.trim() : "";
            const author = authorName
                ? await accounts.byUsername(authorName.toLowerCase())
                : null;
            if (authorName && !author)
                throw new Error(`用户 ${authorName} 不存在`);
            const rows = await store.list({
                viewerId: me.id,
                friendIds,
                author: author?.id,
                before:
                    typeof params.before === "string"
                        ? params.before
                        : undefined,
                beforeId:
                    typeof params.beforeId === "string"
                        ? params.beforeId
                        : undefined,
                limit: limit + 1,
            });
            const hasMore = rows.length > limit;
            const posts = await build(rows.slice(0, limit));
            const result: MomentTimelineResult = { posts, hasMore };
            return result;
        });

        gateway.rpc("moment.like", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as MomentLikeParams;
            const row = await loadVisible(params.postId, me);
            await store.setLike(row.id, me.id, params.liked !== false);
            await notify(row, "like", me);
            return buildOne(row);
        });

        gateway.rpc("moment.comment", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as MomentCommentParams;
            const row = await loadVisible(params.postId, me);
            const content =
                typeof params.content === "string" ? params.content.trim() : "";
            if (!content) throw new Error("评论内容不能为空");
            if (content.length > COMMENT_MAX)
                throw new Error(`评论不能超过 ${COMMENT_MAX} 个字`);
            await store.addComment({
                postId: row.id,
                authorId: me.id,
                content,
            });
            await notify(row, "comment", me);
            return buildOne(row);
        });

        gateway.rpc("moment.delete", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as MomentTargetParams;
            const row = await loadVisible(params.postId, me);
            if (row.authorId !== me.id) throw new Error("只能删除自己的动态");
            await store.remove(row.id);
            await notify(row, "delete", me);
            return true;
        });

        return undefined;
    },
};
