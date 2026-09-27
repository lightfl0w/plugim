import { Context } from "@plugim/core";
import type {
    MomentPost,
    MomentTimelineResult,
    MomentUnreadResult,
} from "@plugim/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "../src/plugins/auth";
import type { RpcService } from "../src/plugins/connection";
import { type MomentsService, momentsPlugin } from "../src/plugins/moments";

const post = (id: string, content: string): MomentPost => ({
    id,
    author: "alice",
    content,
    images: [],
    video: null,
    visibility: "public",
    audience: [],
    createdAt: new Date().toISOString(),
    likes: [],
    comments: [],
});

const authStub = (username: string): AuthService => ({
    token: () => null,
    user: () => ({ id: "u1", username, createdAt: "" }),
    restoring: () => false,
    login: async () => {
        throw new Error("unused");
    },
    register: async () => {
        throw new Error("unused");
    },
    logout: () => undefined,
    setToken: () => undefined,
    onChange: () => () => undefined,
});

const makeMoments = async (
    timeline: MomentTimelineResult = { posts: [], hasMore: false },
    unread: MomentUnreadResult = { posts: 0, interactions: 0, total: 0 },
    username = "me",
) => {
    const ctx = new Context();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    ctx.provide<RpcService>("rpc", {
        call: async (method, params) => {
            calls.push({ method, params });
            if (method === "moment.timeline") return timeline;
            if (method === "moment.unread") return unread;
            if (method === "moment.seen")
                return { posts: 0, interactions: 0, total: 0 };
            if (method === "moment.publish")
                return post("new", String(params.content));
            if (method === "moment.like")
                return {
                    ...post(String(params.postId), "x"),
                    likes: params.liked
                        ? [{ username: "me", at: new Date().toISOString() }]
                        : [],
                };
            if (method === "moment.comment")
                return {
                    ...post(String(params.postId), "x"),
                    comments: [
                        {
                            id: "c1",
                            author: "me",
                            content: String(params.content),
                            createdAt: new Date().toISOString(),
                        },
                    ],
                };
            return true;
        },
        status: () => "connecting",
        onStatus: () => () => undefined,
    });
    ctx.provide<AuthService>("auth", authStub(username));
    ctx.plugin(momentsPlugin);
    await ctx.start();
    return { service: ctx.get<MomentsService>("moments"), calls, ctx };
};

describe("moments service", () => {
    it("starts empty without fetching", async () => {
        const { service, calls } = await makeMoments();
        expect(service.state().posts).toEqual([]);
        expect(service.state().hasMore).toBe(false);
        expect(calls).toEqual([]);
    });

    it("caches the first page and notifies subscribers", async () => {
        const { service } = await makeMoments({
            posts: [post("p1", "一"), post("p2", "二")],
            hasMore: true,
        });
        let updates = 0;
        const dispose = service.onUpdate(() => {
            updates += 1;
        });
        await service.refresh();
        expect(service.state().posts.map((item) => item.id)).toEqual([
            "p1",
            "p2",
        ]);
        expect(service.state().hasMore).toBe(true);
        expect(updates).toBeGreaterThan(0);
        dispose();
        const before = updates;
        await service.refresh();
        expect(updates).toBe(before);
    });

    it("pages with the last post as cursor and dedupes", async () => {
        const first = post("p1", "一");
        const { service, calls } = await makeMoments({
            posts: [first],
            hasMore: false,
        });
        await service.refresh();
        await service.loadMore();
        const page = calls[1];
        expect(page.method).toBe("moment.timeline");
        expect(page.params.before).toBe(first.createdAt);
        expect(page.params.beforeId).toBe("p1");
        expect(service.state().posts.map((item) => item.id)).toEqual(["p1"]);
    });

    it("keeps the current page size when refreshing", async () => {
        const { service, calls } = await makeMoments({
            posts: [post("p1", "一")],
            hasMore: false,
        });
        await service.refresh();
        await service.refresh();
        expect(calls[0].params.limit).toBe(10);
        expect(calls[1].params.limit).toBe(10);
    });

    it("filters by author and clears the list on switch", async () => {
        const { service, calls } = await makeMoments({
            posts: [post("p1", "一")],
            hasMore: false,
        });
        await service.refresh();
        service.setAuthor("bob");
        await service.refresh();
        expect(service.state().author).toBe("bob");
        expect(calls[1].params.author).toBe("bob");
        expect(service.state().posts).toHaveLength(1);
    });

    it("prepends published posts and updates liked ones in place", async () => {
        const { service } = await makeMoments({
            posts: [post("p1", "旧")],
            hasMore: false,
        });
        await service.refresh();
        await service.publish({
            content: "新",
            images: [],
            video: null,
            visibility: "public",
            audience: [],
        });
        expect(service.state().posts.map((item) => item.id)).toEqual([
            "new",
            "p1",
        ]);
        await service.like("p1", true);
        const liked = service.state().posts.find((item) => item.id === "p1");
        expect(liked?.likes.map((like) => like.username)).toEqual(["me"]);
        await service.comment("p1", "说点什么");
        const commented = service
            .state()
            .posts.find((item) => item.id === "p1");
        expect(commented?.comments[0].content).toBe("说点什么");
        await service.remove("p1");
        expect(service.state().posts.map((item) => item.id)).toEqual(["new"]);
    });

    it("refetches when the server announces an update", async () => {
        const { service, calls, ctx } = await makeMoments({
            posts: [post("p1", "一")],
            hasMore: false,
        });
        await service.refresh();
        const timelines = () =>
            calls.filter((call) => call.method === "moment.timeline").length;
        expect(timelines()).toBe(1);
        ctx.emit("server:moment:update", {
            action: "publish",
            postId: "p1",
            author: "alice",
        });
        await vi.waitFor(() => expect(timelines()).toBe(2));
    });

    it("records failures in state instead of rejecting", async () => {
        const ctx = new Context();
        ctx.provide<RpcService>("rpc", {
            call: async () => {
                throw new Error("offline");
            },
            status: () => "connecting",
            onStatus: () => () => undefined,
        });
        ctx.provide<AuthService>("auth", authStub("me"));
        ctx.plugin(momentsPlugin);
        await ctx.start();
        const service = ctx.get<MomentsService>("moments");
        await expect(service.refresh()).resolves.toBeUndefined();
        expect(service.state().error).toBe("offline");
        expect(service.state().loading).toBe(false);
    });

    it("stops listening after dispose", async () => {
        const { service, calls, ctx } = await makeMoments({
            posts: [post("p1", "一")],
            hasMore: false,
        });
        await service.refresh();
        await ctx.stop();
        ctx.emit("server:moment:update", {
            action: "like",
            postId: "p1",
            author: "bob",
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(calls).toHaveLength(1);
    });

    it("passes the video and the picked audience to the server", async () => {
        const { service, calls } = await makeMoments();
        await service.publish({
            content: "视频",
            images: [],
            video: "clip-key",
            visibility: "partial",
            audience: ["bob", "carol"],
        });
        expect(calls[0].method).toBe("moment.publish");
        expect(calls[0].params).toMatchObject({
            content: "视频",
            video: "clip-key",
            visibility: "partial",
            audience: ["bob", "carol"],
        });
    });

    it("counts unread posts and interactions from friend activity", async () => {
        const { service, calls, ctx } = await makeMoments(
            { posts: [], hasMore: false },
            { posts: 2, interactions: 1, total: 3 },
        );
        expect(service.state().unread.total).toBe(0);
        ctx.emit("server:moment:update", {
            action: "like",
            postId: "p1",
            author: "bob",
            owner: "me",
        });
        await vi.waitFor(() => expect(service.state().unread.total).toBe(3));
        expect(
            calls.filter((call) => call.method === "moment.unread").length,
        ).toBeGreaterThan(0);
    });

    it("clears unread while the feed is open and pulls it again after leaving", async () => {
        const { service, calls } = await makeMoments(
            { posts: [], hasMore: false },
            { posts: 4, interactions: 0, total: 4 },
        );
        service.setViewing(true);
        await vi.waitFor(() =>
            expect(calls.some((call) => call.method === "moment.seen")).toBe(
                true,
            ),
        );
        await vi.waitFor(() => expect(service.state().unread.total).toBe(0));
        service.setViewing(false);
        await vi.waitFor(() => expect(service.state().unread.total).toBe(4));
    });
});

describe("moments alerts", () => {
    const withHiddenTab = (notes: { title: string; body: string }[]) => {
        vi.stubGlobal("document", {
            visibilityState: "hidden",
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        });
        vi.stubGlobal(
            "Notification",
            class {
                static permission = "granted";
                onclick: (() => void) | null = null;
                constructor(title: string, options?: { body?: string }) {
                    notes.push({ title, body: options?.body ?? "" });
                }
            },
        );
    };

    it("raises a desktop notification for likes and comments on my post", async () => {
        const notes: { title: string; body: string }[] = [];
        withHiddenTab(notes);
        const { ctx } = await makeMoments(
            { posts: [], hasMore: false },
            { posts: 0, interactions: 0, total: 0 },
            "carol",
        );
        ctx.emit("server:moment:update", {
            action: "like",
            postId: "p1",
            author: "bob",
            owner: "carol",
        });
        ctx.emit("server:moment:update", {
            action: "comment",
            postId: "p2",
            author: "dave",
            owner: "carol",
        });
        expect(notes).toEqual([
            { title: "朋友圈", body: "bob 赞了你的动态" },
            { title: "朋友圈", body: "dave 评论了你的动态" },
        ]);
        vi.unstubAllGlobals();
    });

    it("skips notifications for visible tabs, own actions and other people", async () => {
        const notes: { title: string; body: string }[] = [];
        withHiddenTab(notes);
        const { ctx } = await makeMoments(
            { posts: [], hasMore: false },
            { posts: 0, interactions: 0, total: 0 },
            "carol",
        );
        ctx.emit("server:moment:update", {
            action: "like",
            postId: "p1",
            author: "bob",
            owner: "dave",
        });
        ctx.emit("server:moment:update", {
            action: "like",
            postId: "p1",
            author: "carol",
            owner: "carol",
        });
        ctx.emit("server:moment:update", {
            action: "publish",
            postId: "p3",
            author: "bob",
            owner: "carol",
        });
        const visible = new Context();
        vi.stubGlobal("document", {
            visibilityState: "visible",
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
        });
        visible.provide<RpcService>("rpc", {
            call: async () => true,
            status: () => "connecting",
            onStatus: () => () => undefined,
        });
        visible.provide<AuthService>("auth", authStub("carol"));
        visible.plugin(momentsPlugin);
        await visible.start();
        visible.emit("server:moment:update", {
            action: "like",
            postId: "p1",
            author: "bob",
            owner: "carol",
        });
        await visible.stop();
        expect(notes).toEqual([]);
        vi.unstubAllGlobals();
    });
});
