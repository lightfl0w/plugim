import { Context } from "@plugim/core";
import type { MomentPost, MomentTimelineResult } from "@plugim/protocol";
import { describe, expect, it, vi } from "vitest";
import type { RpcService } from "../src/plugins/connection";
import { type MomentsService, momentsPlugin } from "../src/plugins/moments";

const post = (id: string, content: string): MomentPost => ({
    id,
    author: "alice",
    content,
    images: [],
    visibility: "public",
    createdAt: new Date().toISOString(),
    likes: [],
    comments: [],
});

const makeMoments = async (
    timeline: MomentTimelineResult = { posts: [], hasMore: false },
) => {
    const ctx = new Context();
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    ctx.provide<RpcService>("rpc", {
        call: async (method, params) => {
            calls.push({ method, params });
            if (method === "moment.timeline") return timeline;
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
            visibility: "public",
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
        expect(calls).toHaveLength(1);
        ctx.emit("server:moment:update", {
            action: "publish",
            postId: "p1",
            author: "alice",
        });
        await vi.waitFor(() => expect(calls).toHaveLength(2));
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
});
