import type {
    MomentPost,
    MomentTimelineResult,
    MomentUnreadResult,
} from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import { createTestApp, type TestApp, uploadFile } from "./helpers";

const feedOf = async (
    app: Awaited<ReturnType<typeof createTestApp>>,
    user: { id: string },
    params: Record<string, unknown> = {},
) =>
    (await app.call(
        "moment.timeline",
        params,
        user as never,
    )) as unknown as MomentTimelineResult;

const unreadOf = async (
    app: TestApp,
    user: { id: string },
): Promise<MomentUnreadResult> =>
    (await app.call("moment.unread", {}, user as never)) as MomentUnreadResult;

type SignedIn = Awaited<ReturnType<TestApp["register"]>>;

const befriend = async (app: TestApp, a: SignedIn, b: SignedIn) => {
    await app.call("friend.request", { username: b.user.username }, a.user);
    await app.call("friend.accept", { username: a.user.username }, b.user);
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const friendPair = async (a: string, b: string) => {
    const app = await createTestApp();
    const ua = await app.register(a);
    const ub = await app.register(b);
    await app.call("friend.request", { username: b }, ua.user);
    await app.call("friend.accept", { username: a }, ub.user);
    return { app, ua, ub };
};

describe("moment timeline", () => {
    it("shows friends-only posts to friends and hides them from strangers", async () => {
        const { app, ua, ub } = await friendPair("ma", "mb");
        const stranger = await app.register("mc");
        await app.call(
            "moment.publish",
            { content: "只给好友看", visibility: "friends" },
            ua.user,
        );
        const mine = await feedOf(app, ua.user);
        expect(mine.posts).toHaveLength(1);
        const friend = await feedOf(app, ub.user);
        expect(friend.posts.map((post) => post.content)).toEqual([
            "只给好友看",
        ]);
        const other = await feedOf(app, stranger.user);
        expect(other.posts).toEqual([]);
    });

    it("shows public posts to everyone", async () => {
        const { app, ua } = await friendPair("na", "nb");
        const stranger = await app.register("nc");
        await app.call("moment.publish", { content: "公开动态" }, ua.user);
        const other = await feedOf(app, stranger.user);
        expect(other.posts.map((post) => post.content)).toEqual(["公开动态"]);
    });

    it("filters the feed by author without leaking friends-only posts", async () => {
        const { app, ua, ub } = await friendPair("oa", "ob");
        const stranger = await app.register("oc");
        await app.call(
            "moment.publish",
            { content: "隐藏", visibility: "friends" },
            ua.user,
        );
        await app.call("moment.publish", { content: "公开" }, ua.user);
        const friend = await feedOf(app, ub.user, { author: "oa" });
        expect(friend.posts).toHaveLength(2);
        const other = await feedOf(app, stranger.user, { author: "oa" });
        expect(other.posts.map((post) => post.content)).toEqual(["公开"]);
    });

    it("sorts newest first and reports hasMore", async () => {
        const { app, ua } = await friendPair("pa", "pb");
        for (const content of ["一", "二", "三"]) {
            await app.call("moment.publish", { content }, ua.user);
        }
        const first = await feedOf(app, ua.user, { limit: 2 });
        expect(first.posts.map((post) => post.content)).toEqual(["三", "二"]);
        expect(first.hasMore).toBe(true);
        const last = first.posts[first.posts.length - 1];
        const second = await feedOf(app, ua.user, {
            limit: 2,
            before: last.createdAt,
            beforeId: last.id,
        });
        expect(second.posts.map((post) => post.content)).toEqual(["一"]);
        expect(second.hasMore).toBe(false);
    });

    it("keeps at most nine images and rejects unknown ones", async () => {
        const { app, ua } = await friendPair("qa", "qb");
        const keys: string[] = [];
        for (let i = 0; i < 10; i++) {
            const upload = await uploadFile(
                app,
                ua.token,
                `q${i}.png`,
                "image/png",
                8,
            );
            keys.push(upload.key);
        }
        const post = (await app.call(
            "moment.publish",
            { content: "图", images: keys },
            ua.user,
        )) as MomentPost;
        expect(post.images).toEqual(keys.slice(0, 9));
        await expect(
            app.call(
                "moment.publish",
                { content: "坏图", images: ["missing-key"] },
                ua.user,
            ),
        ).rejects.toThrow("图片或视频不存在或已被删除");
    });

    it("rejects empty posts and oversized text", async () => {
        const { app, ua } = await friendPair("ra", "rb");
        await expect(
            app.call("moment.publish", { content: "   " }, ua.user),
        ).rejects.toThrow("动态内容不能为空");
        await expect(
            app.call("moment.publish", { content: "字".repeat(1001) }, ua.user),
        ).rejects.toThrow("内容不能超过 1000 个字");
    });

    it("requires a signed in user", async () => {
        const app = await createTestApp();
        await expect(app.call("moment.timeline", {})).rejects.toThrow(
            "未登录或登录已过期",
        );
    });
});

describe("moment likes and comments", () => {
    it("lets friends like, unlike and comment", async () => {
        const { app, ua, ub } = await friendPair("sa", "sb");
        const post = (await app.call(
            "moment.publish",
            { content: "点赞我" },
            ua.user,
        )) as MomentPost;
        const liked = (await app.call(
            "moment.like",
            { postId: post.id, liked: true },
            ub.user,
        )) as MomentPost;
        expect(liked.likes.map((like) => like.username)).toEqual(["sb"]);
        const again = (await app.call(
            "moment.like",
            { postId: post.id, liked: true },
            ub.user,
        )) as MomentPost;
        expect(again.likes).toHaveLength(1);
        const unliked = (await app.call(
            "moment.like",
            { postId: post.id, liked: false },
            ub.user,
        )) as MomentPost;
        expect(unliked.likes).toEqual([]);
        const commented = (await app.call(
            "moment.comment",
            { postId: post.id, content: "  好耶  " },
            ub.user,
        )) as MomentPost;
        expect(commented.comments).toHaveLength(1);
        expect(commented.comments[0].author).toBe("sb");
        expect(commented.comments[0].content).toBe("好耶");
    });

    it("blocks strangers from friends-only posts", async () => {
        const { app, ua } = await friendPair("ta", "tb");
        const stranger = await app.register("tc");
        const post = (await app.call(
            "moment.publish",
            { content: "私密", visibility: "friends" },
            ua.user,
        )) as MomentPost;
        await expect(
            app.call("moment.like", { postId: post.id }, stranger.user),
        ).rejects.toThrow("无权查看该动态");
        await expect(
            app.call(
                "moment.comment",
                { postId: post.id, content: "看得到吗" },
                stranger.user,
            ),
        ).rejects.toThrow("无权查看该动态");
        await expect(
            app.call(
                "moment.comment",
                { postId: "nope", content: "hi" },
                ua.user,
            ),
        ).rejects.toThrow("动态不存在或已被删除");
        await expect(
            app.call(
                "moment.comment",
                { postId: post.id, content: " " },
                ua.user,
            ),
        ).rejects.toThrow("评论内容不能为空");
    });

    it("only lets the author delete a post", async () => {
        const { app, ua, ub } = await friendPair("ua", "ub");
        const post = (await app.call(
            "moment.publish",
            { content: "删我" },
            ua.user,
        )) as MomentPost;
        await expect(
            app.call("moment.delete", { postId: post.id }, ub.user),
        ).rejects.toThrow("只能删除自己的动态");
        await app.call("moment.delete", { postId: post.id }, ua.user);
        expect((await feedOf(app, ua.user)).posts).toEqual([]);
    });
});

describe("moment events", () => {
    it("notifies the author and friends, but not strangers", async () => {
        const { app, ua, ub } = await friendPair("va", "vb");
        const stranger = await app.register("vc");
        await app.call("moment.publish", { content: "新动态" }, ua.user);
        const friendEvents = app.eventsFor(ub.user.id, "moment:update");
        expect(friendEvents).toHaveLength(1);
        const authorEvents = app.eventsFor(ua.user.id, "moment:update");
        expect(authorEvents).toHaveLength(1);
        expect(app.eventsFor(stranger.user.id, "moment:update")).toEqual([]);
        const post = (await feedOf(app, ua.user)).posts[0];
        await app.call(
            "moment.like",
            { postId: post.id, liked: true },
            ub.user,
        );
        await app.call(
            "moment.comment",
            { postId: post.id, content: "赞" },
            ub.user,
        );
        await app.call("moment.delete", { postId: post.id }, ua.user);
        const actions = app
            .eventsFor(ub.user.id, "moment:update")
            .map((event) => (event.payload as { action: string }).action);
        expect(actions).toEqual(["publish", "like", "comment", "delete"]);
    });

    it("carries the post owner so clients can spot their own likes", async () => {
        const { app, ua, ub } = await friendPair("wa", "wb");
        const post = (await app.call(
            "moment.publish",
            { content: "被赞" },
            ua.user,
        )) as MomentPost;
        await app.call(
            "moment.like",
            { postId: post.id, liked: true },
            ub.user,
        );
        const mine = app
            .eventsFor(ua.user.id, "moment:update")
            .map((event) => event.payload as { action: string; owner: string });
        expect(mine[mine.length - 1]).toMatchObject({
            action: "like",
            owner: "wa",
            author: "wb",
        });
    });
});

describe("moment audience", () => {
    it("shows partial posts only to the picked friends", async () => {
        const app = await createTestApp();
        const ua = await app.register("xa");
        const ub = await app.register("xb");
        const uc = await app.register("xc");
        const stranger = await app.register("xd");
        await befriend(app, ua, ub);
        await befriend(app, ua, uc);
        const post = (await app.call(
            "moment.publish",
            { content: "只给 xb 看", visibility: "partial", audience: ["XB"] },
            ua.user,
        )) as MomentPost;
        expect(post.audience).toEqual(["xb"]);
        expect((await feedOf(app, ua.user)).posts).toHaveLength(1);
        expect(
            (await feedOf(app, ub.user)).posts.map((p) => p.content),
        ).toEqual(["只给 xb 看"]);
        expect((await feedOf(app, uc.user)).posts).toEqual([]);
        expect((await feedOf(app, stranger.user)).posts).toEqual([]);
        const seenByFriend = (await feedOf(app, ub.user)).posts[0];
        expect(seenByFriend.audience).toEqual([]);
        await expect(
            app.call("moment.like", { postId: post.id }, uc.user),
        ).rejects.toThrow("无权查看该动态");
        await expect(
            app.call("moment.like", { postId: post.id }, ub.user),
        ).resolves.toBeTruthy();
    });

    it("hides excluded friends from the post", async () => {
        const app = await createTestApp();
        const ua = await app.register("ya");
        const ub = await app.register("yb");
        const uc = await app.register("yc");
        await befriend(app, ua, ub);
        await befriend(app, ua, uc);
        await app.call(
            "moment.publish",
            { content: "不给 yb 看", visibility: "exclude", audience: ["yb"] },
            ua.user,
        );
        expect((await feedOf(app, ub.user)).posts).toEqual([]);
        expect(
            (await feedOf(app, uc.user)).posts.map((p) => p.content),
        ).toEqual(["不给 yb 看"]);
    });

    it("validates the picked audience", async () => {
        const app = await createTestApp();
        const ua = await app.register("za");
        const ub = await app.register("zb");
        await befriend(app, ua, ub);
        await expect(
            app.call(
                "moment.publish",
                { content: "空的", visibility: "partial", audience: [] },
                ua.user,
            ),
        ).rejects.toThrow("请选择可见的好友");
        await expect(
            app.call(
                "moment.publish",
                {
                    content: "只有自己",
                    visibility: "partial",
                    audience: ["za"],
                },
                ua.user,
            ),
        ).rejects.toThrow("请选择可见的好友");
        await expect(
            app.call(
                "moment.publish",
                { content: "陌生人", visibility: "exclude", audience: ["zz"] },
                ua.user,
            ),
        ).rejects.toThrow("只能选择好友，zz 不是你的好友");
        await expect(
            app.call(
                "moment.publish",
                {
                    content: "公开的动态不需要名单",
                    visibility: "public",
                    audience: ["zb"],
                },
                ua.user,
            ),
        ).resolves.toMatchObject({ audience: [] });
    });
});

describe("moment video", () => {
    it("accepts a single video and rejects mixed media", async () => {
        const { app, ua } = await friendPair("va2", "vb2");
        const video = await uploadFile(
            app,
            ua.token,
            "clip.mp4",
            "video/mp4",
            16,
        );
        const image = await uploadFile(app, ua.token, "a.png", "image/png", 8);
        const post = (await app.call(
            "moment.publish",
            { content: "视频动态", video: video.key },
            ua.user,
        )) as MomentPost;
        expect(post.video).toBe(video.key);
        expect(post.images).toEqual([]);
        expect((await feedOf(app, ua.user)).posts[0].video).toBe(video.key);
        await expect(
            app.call(
                "moment.publish",
                { content: "混合", video: video.key, images: [image.key] },
                ua.user,
            ),
        ).rejects.toThrow("视频动态不能同时包含图片");
        await expect(
            app.call("moment.publish", { video: "missing-key" }, ua.user),
        ).rejects.toThrow("图片或视频不存在或已被删除");
        await expect(
            app.call("moment.publish", { content: "  " }, ua.user),
        ).rejects.toThrow("动态内容不能为空");
    });
});

describe("moment unread", () => {
    it("counts new friend posts until the feed is marked seen", async () => {
        const { app, ua, ub } = await friendPair("ua2", "ub2");
        const stranger = await app.register("uc2");
        await expect(unreadOf(app, ub.user)).resolves.toEqual({
            posts: 0,
            interactions: 0,
            total: 0,
        });
        await app.call("moment.publish", { content: "第一条" }, ua.user);
        await app.call("moment.publish", { content: "第二条" }, ua.user);
        await app.call("moment.seen", {}, ub.user);
        await tick();
        await app.call("moment.publish", { content: "第三条" }, ua.user);
        await app.call(
            "moment.publish",
            { content: "陌生人的动态" },
            stranger.user,
        );
        expect(await unreadOf(app, ub.user)).toEqual({
            posts: 1,
            interactions: 0,
            total: 1,
        });
        await app.call("moment.seen", {}, ub.user);
        await expect(unreadOf(app, ub.user)).resolves.toEqual({
            posts: 0,
            interactions: 0,
            total: 0,
        });
    });

    it("hides posts that are not visible to the viewer", async () => {
        const app = await createTestApp();
        const ua = await app.register("ud2");
        const ub = await app.register("ue2");
        await befriend(app, ua, ub);
        await app.call(
            "moment.publish",
            { content: "不给 ue2", visibility: "exclude", audience: ["ue2"] },
            ua.user,
        );
        await app
            .call(
                "moment.publish",
                { content: "部分可见", visibility: "partial", audience: [] },
                ua.user,
            )
            .catch(() => undefined);
        await app.call("moment.publish", { content: "公开" }, ua.user);
        expect(await unreadOf(app, ub.user)).toEqual({
            posts: 1,
            interactions: 0,
            total: 1,
        });
    });

    it("counts likes and comments from others on my posts", async () => {
        const { app, ua, ub } = await friendPair("uf2", "ug2");
        const post = (await app.call(
            "moment.publish",
            { content: "点赞我" },
            ua.user,
        )) as MomentPost;
        await app.call("moment.seen", {}, ua.user);
        await tick();
        await app.call(
            "moment.like",
            { postId: post.id, liked: true },
            ub.user,
        );
        await app.call(
            "moment.comment",
            { postId: post.id, content: "沙发" },
            ub.user,
        );
        await app.call(
            "moment.like",
            { postId: post.id, liked: true },
            ua.user,
        );
        expect(await unreadOf(app, ua.user)).toEqual({
            posts: 0,
            interactions: 2,
            total: 2,
        });
        await app.call("moment.seen", {}, ua.user);
        await expect(unreadOf(app, ua.user)).resolves.toEqual({
            posts: 0,
            interactions: 0,
            total: 0,
        });
    });

    it("requires a signed in user", async () => {
        const app = await createTestApp();
        await expect(app.call("moment.unread", {})).rejects.toThrow(
            "未登录或登录已过期",
        );
        await expect(app.call("moment.seen", {})).rejects.toThrow(
            "未登录或登录已过期",
        );
    });
});
