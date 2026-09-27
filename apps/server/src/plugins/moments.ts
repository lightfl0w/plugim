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
    MomentUnreadResult,
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
import type { PushService } from "./push";

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const CONTENT_MAX = 1000;
const COMMENT_MAX = 300;
const IMAGES_MAX = 9;
const AUDIENCE_MAX = 200;
const TIMELINE_MAX = 30;
const TIMELINE_DEFAULT = 10;
const KEY_MAX = 200;

const VISIBILITIES: MomentVisibility[] = [
    "public",
    "friends",
    "partial",
    "exclude",
];

const clampLimit = (value: unknown): number => {
    const num = Math.floor(Number(value));
    if (!Number.isFinite(num) || num <= 0) return TIMELINE_DEFAULT;
    return Math.min(num, TIMELINE_MAX);
};

export const momentsPlugin: Plugin = {
    name: "moments",
    description: "朋友圈动态、点赞与评论 RPC",
    provides: ["moment-rpc"],
    inject: [
        "gateway",
        "accounts",
        "friendships",
        "moments",
        "mediaFiles",
        "push",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const friendships = ctx.get<FriendsStore>("friendships");
        const store = ctx.get<MomentsStore>("moments");
        const mediaFiles = ctx.get<MediaFilesStore>("mediaFiles");
        const push = ctx.get<PushService>("push");

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

        const build = async (
            rows: MomentRow[],
            viewerId: string,
        ): Promise<MomentPost[]> => {
            const ids = rows.map((row) => row.id);
            const [likes, comments] = await Promise.all([
                store.likesOf(ids),
                store.commentsOf(ids),
            ]);
            const audienceIds = [
                ...new Set(rows.flatMap((row) => row.audience)),
            ];
            const users = await accounts.byIds([
                ...rows.map((row) => row.authorId),
                ...likes.map((like) => like.userId),
                ...comments.map((comment) => comment.authorId),
                ...audienceIds,
            ]);
            const nameById = new Map(
                users.map((user) => [user.id, user.username]),
            );
            return rows.map((row) => ({
                id: row.id,
                author: nameById.get(row.authorId) ?? "未知用户",
                content: row.content,
                images: row.images,
                video: row.video,
                visibility: row.visibility,
                audience:
                    row.authorId === viewerId
                        ? row.audience
                              .map((id) => nameById.get(id) ?? "")
                              .filter(Boolean)
                        : [],
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

        const buildOne = async (
            row: MomentRow,
            viewerId: string,
        ): Promise<MomentPost> => {
            const [post] = await build([row], viewerId);
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
            if (row.visibility === "friends") {
                const friendIds = await friendIdsOf(me.id);
                if (friendIds.includes(row.authorId)) return row;
            } else {
                const audience = await store.audienceOf(row.id);
                if (row.visibility === "partial" && audience.includes(me.id))
                    return row;
                if (row.visibility === "exclude" && !audience.includes(me.id))
                    return row;
            }
            throw new Error("无权查看该动态");
        };

        const notify = async (
            row: MomentRow,
            action: MomentAction,
            actor: AuthUser,
        ) => {
            const owner = await accounts.byId(row.authorId);
            const recipients = new Set([
                row.authorId,
                ...(await friendIdsOf(row.authorId)),
            ]);
            for (const id of recipients)
                gateway.emitToUser(id, "moment:update", {
                    action,
                    postId: row.id,
                    author: actor.username,
                    owner: owner?.username ?? actor.username,
                });
            if (action !== "like" && action !== "comment") return;
            if (row.authorId === actor.id) return;
            push.deliver([row.authorId], {
                title: "朋友圈",
                body: `${actor.username} ${action === "like" ? "赞了" : "评论了"}你的动态`,
                session: "moments",
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
            const rawVideo =
                typeof params.video === "string" ? params.video.trim() : "";
            const video =
                rawVideo && rawVideo.length <= KEY_MAX ? rawVideo : null;
            if (video && keys.length > 0)
                throw new Error("视频动态不能同时包含图片");
            if (!content && !video && keys.length === 0)
                throw new Error("动态内容不能为空");
            for (const key of [...keys, ...(video ? [video] : [])]) {
                if (!(await mediaFiles.byKey(key)))
                    throw new Error("图片或视频不存在或已被删除");
            }
            const visibility: MomentVisibility = VISIBILITIES.includes(
                params.visibility as MomentVisibility,
            )
                ? (params.visibility as MomentVisibility)
                : "public";
            let audience: string[] = [];
            if (visibility === "partial" || visibility === "exclude") {
                const names = [
                    ...new Set(
                        (Array.isArray(params.audience) ? params.audience : [])
                            .filter(
                                (name): name is string =>
                                    typeof name === "string",
                            )
                            .map((name) => name.trim().toLowerCase())
                            .filter((name) => name && name !== me.username),
                    ),
                ];
                if (names.length === 0) throw new Error("请选择可见的好友");
                if (names.length > AUDIENCE_MAX)
                    throw new Error(`最多选择 ${AUDIENCE_MAX} 位好友`);
                const friendIds = new Set(await friendIdsOf(me.id));
                const ids: string[] = [];
                for (const name of names) {
                    const user = await accounts.byUsername(name);
                    if (!user || !friendIds.has(user.id))
                        throw new Error(`只能选择好友，${name} 不是你的好友`);
                    ids.push(user.id);
                }
                audience = ids;
            }
            const row = await store.create({
                authorId: me.id,
                content,
                images: keys,
                video,
                visibility,
                audience,
            });
            await notify(row, "publish", me);
            return buildOne(row, me.id);
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
            const posts = await build(rows.slice(0, limit), me.id);
            const result: MomentTimelineResult = { posts, hasMore };
            return result;
        });

        gateway.rpc("moment.like", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as MomentLikeParams;
            const row = await loadVisible(params.postId, me);
            await store.setLike(row.id, me.id, params.liked !== false);
            await notify(row, "like", me);
            return buildOne(row, me.id);
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
            return buildOne(row, me.id);
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

        gateway.rpc("moment.unread", async (_raw, conn) => {
            const me = requireUser(conn);
            const counts = await store.unread(me.id, await friendIdsOf(me.id));
            const result: MomentUnreadResult = {
                posts: counts.posts,
                interactions: counts.interactions,
                total: counts.posts + counts.interactions,
            };
            return result;
        });

        gateway.rpc("moment.seen", async (_raw, conn) => {
            const me = requireUser(conn);
            await store.markSeen(me.id, new Date().toISOString());
            const result: MomentUnreadResult = {
                posts: 0,
                interactions: 0,
                total: 0,
            };
            return result;
        });

        return undefined;
    },
};
