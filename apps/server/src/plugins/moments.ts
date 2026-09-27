import type { Plugin } from "@plugim/core";
import type {
    MomentAction,
    MomentCommentParams,
    MomentLikeParams,
    MomentLink,
    MomentLinkParams,
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

const LINK_URL_MAX = 500;
const LINK_TEXT_MAX = 200;
const LINK_DESC_MAX = 300;
const LINK_TIMEOUT_MS = 5000;
const LINK_BYTES_MAX = 512 * 1024;
const LINK_REDIRECT_MAX = 3;
const LINK_UA = "Mozilla/5.0 (compatible; plugim/1.0; +link-preview)";

const decodeHtml = (raw: string): string => {
    const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
    };
    return raw.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
        (match, code: string) => {
            const lower = code.toLowerCase();
            if (lower.startsWith("#")) {
                const hex = lower.startsWith("#x");
                const value = Number.parseInt(
                    lower.slice(hex ? 2 : 1),
                    hex ? 16 : 10,
                );
                if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff)
                    return match;
                return String.fromCodePoint(value);
            }
            return named[lower] ?? match;
        },
    );
};

const metaContent = (html: string): Map<string, string> => {
    const map = new Map<string, string>();
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        let key = "";
        let content: string | null = null;
        for (const attr of tag.matchAll(
            /([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
        )) {
            const name = attr[1].toLowerCase();
            const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
            if (name === "property" || name === "name")
                key = value.toLowerCase();
            else if (name === "content") content = value;
        }
        if (key && content !== null && !map.has(key))
            map.set(key, decodeHtml(content).trim());
    }
    return map;
};

const isPrivateV4 = (host: string): boolean => {
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length !== 4) return false;
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return false;
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
};

const isPrivateHost = (hostname: string): boolean => {
    const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".home.arpa")
    )
        return true;
    if (host.includes(":")) {
        if (host === "::" || host === "::1") return true;
        const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateV4(mapped[1]);
        const mappedHex = host.match(
            /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
        );
        if (mappedHex) {
            const high = Number.parseInt(mappedHex[1], 16);
            const low = Number.parseInt(mappedHex[2], 16);
            return isPrivateV4(
                `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
            );
        }
        const head = host.split(":")[0];
        if (/^fe[89ab]/.test(head)) return true;
        if (head.startsWith("fc") || head.startsWith("fd")) return true;
        if (head.startsWith("ff")) return true;
        return false;
    }
    if (isPrivateV4(host)) return true;
    return !host.includes(".");
};

const toPublicUrl = (value: string): URL => {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error("链接地址无效");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("仅支持 http/https 链接");
    if (url.username || url.password) throw new Error("链接不能包含账号密码");
    if (isPrivateHost(url.hostname)) throw new Error("不支持访问内网地址");
    return url;
};

const readHtml = async (response: Response): Promise<string> => {
    const body = response.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            size += value.byteLength;
            if (size > LINK_BYTES_MAX) break;
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
};

const resolveImage = (value: string, base: string): string | null => {
    if (!value) return null;
    try {
        const url = new URL(value, base);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.href;
    } catch {
        return null;
    }
};

const fetchLinkMeta = async (rawUrl: unknown): Promise<MomentLink> => {
    const candidate = typeof rawUrl === "string" ? rawUrl.trim() : "";
    if (!candidate) throw new Error("请输入链接地址");
    if (candidate.length > LINK_URL_MAX)
        throw new Error(`链接不能超过 ${LINK_URL_MAX} 个字符`);
    let current = candidate.includes("://")
        ? candidate
        : `https://${candidate}`;
    let response: Response | null = null;
    for (let hop = 0; hop <= LINK_REDIRECT_MAX; hop += 1) {
        const target = toPublicUrl(current);
        try {
            response = await fetch(target, {
                redirect: "manual",
                headers: {
                    accept: "text/html,application/xhtml+xml",
                    "user-agent": LINK_UA,
                },
                signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
            });
        } catch {
            throw new Error("链接无法访问");
        }
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        if (!location) throw new Error("链接无法访问");
        if (hop === LINK_REDIRECT_MAX) throw new Error("链接重定向次数过多");
        current = new URL(location, target).href;
    }
    if (!response) throw new Error("链接无法访问");
    if (!response.ok) throw new Error(`链接无法访问（${response.status}）`);
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!type.includes("text/html")) throw new Error("链接不是网页");
    const html = await readHtml(response);
    const meta = metaContent(html);
    const host = new URL(current).hostname.replace(/^www\./i, "");
    const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = (
        meta.get("og:title") ||
        meta.get("twitter:title") ||
        (titleTag ? decodeHtml(titleTag[1]).trim() : "")
    ).slice(0, LINK_TEXT_MAX);
    const description = (
        meta.get("og:description") ||
        meta.get("description") ||
        meta.get("twitter:description") ||
        ""
    ).slice(0, LINK_DESC_MAX);
    return {
        url: current,
        title: title || host,
        description,
        image: resolveImage(
            meta.get("og:image") ||
                meta.get("og:image:url") ||
                meta.get("twitter:image") ||
                "",
            current,
        ),
        site: (meta.get("og:site_name") || "").slice(0, LINK_TEXT_MAX) || host,
    };
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
                link: row.link,
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
            const rawLink =
                typeof params.link === "string" ? params.link.trim() : "";
            if (rawLink && keys.length > 0)
                throw new Error("链接动态不能同时包含图片");
            if (rawLink && video) throw new Error("链接动态不能同时包含视频");
            if (!content && !video && keys.length === 0 && !rawLink)
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
                link: rawLink ? await fetchLinkMeta(rawLink) : null,
                visibility,
                audience,
            });
            await notify(row, "publish", me);
            return buildOne(row, me.id);
        });

        gateway.rpc("moment.link", async (raw, conn) => {
            requireUser(conn);
            const params = raw as unknown as MomentLinkParams;
            return fetchLinkMeta(params.url);
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
