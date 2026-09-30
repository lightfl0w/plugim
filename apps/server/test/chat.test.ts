import { afterEach, describe, expect, it, vi } from "vitest";
import { linkTransport } from "../src/plugins/link-preview";
import type { AuthUser } from "../src/types";
import { createTestApp, type TestApp } from "./helpers";

const friendPair = async (a: string, b: string) => {
    const app = await createTestApp();
    const ua = await app.register(a);
    const ub = await app.register(b);
    await app.call("friend.request", { username: b }, ua.user);
    await app.call("friend.accept", { username: a }, ub.user);
    return { app, ua, ub };
};

describe("p2p messaging", () => {
    it("only allows friends to chat", async () => {
        const app = await createTestApp();
        const ua = await app.register("pa");
        const ub = await app.register("pb");
        await expect(
            app.call(
                "message.send",
                { session: "p2p:pb", content: "hi" },
                ua.user,
            ),
        ).rejects.toThrow("只能和好友私聊");
        await app.call("friend.request", { username: "pb" }, ua.user);
        await app.call("friend.accept", { username: "pa" }, ub.user);
        const sent = (await app.call(
            "message.send",
            { session: "p2p:pb", content: "hi" },
            ua.user,
        )) as { session: string };
        expect(sent.session).toBe("p2p:pb");
    });

    it("delivers mirrored events to both sides", async () => {
        const { app, ua, ub } = await friendPair("qa", "qb");
        await app.call(
            "message.send",
            { session: "p2p:qb", content: "hello" },
            ua.user,
        );
        const mine = app.eventsFor(ua.user.id, "message:new");
        const theirs = app.eventsFor(ub.user.id, "message:new");
        const mineMsg = (
            mine[0] as { payload: { message: { session: string } } }
        ).payload.message;
        const theirsMsg = (
            theirs[0] as { payload: { message: { session: string } } }
        ).payload.message;
        expect(mineMsg.session).toBe("p2p:qb");
        expect(theirsMsg.session).toBe("p2p:qa");
    });

    it("keeps each friend's history isolated", async () => {
        const { app, ua, ub } = await friendPair("ha", "hb");
        const other = await app.register("hc");
        await app.call(
            "message.send",
            { session: "p2p:hb", content: "secret" },
            ua.user,
        );
        const history = (await app.call(
            "history.list",
            { session: "p2p:ha" },
            ub.user,
        )) as unknown[];
        expect(history).toHaveLength(1);
        await expect(
            app.call("history.list", { session: "p2p:hb" }, other.user),
        ).rejects.toThrow();
    });

    it("forwards a message to multiple sessions", async () => {
        const { app, ua } = await friendPair("fa", "fb");
        const fc = await app.register("fc");
        await app.call("friend.request", { username: "fc" }, ua.user);
        await app.call("friend.accept", { username: "fa" }, fc.user);
        const sent = (await app.call(
            "message.send",
            { session: "p2p:fb", content: "重要通知" },
            ua.user,
        )) as { id: string };
        const forwarded = (await app.call(
            "message.forward",
            { id: sent.id, sessions: ["p2p:fc", "general"] },
            ua.user,
        )) as { session: string; content: string; sender: string }[];
        expect(forwarded.map((m) => m.session)).toEqual(["p2p:fc", "general"]);
        expect(forwarded[0]).toMatchObject({
            content: "重要通知",
            sender: "fa",
        });
        const fcHistory = (await app.call(
            "history.list",
            { session: "p2p:fa" },
            fc.user,
        )) as unknown[];
        expect(fcHistory).toHaveLength(1);
    });

    it("merges multiple messages into one chat-record card", async () => {
        const { app, ua } = await friendPair("ma", "mb");
        const first = (await app.call(
            "message.send",
            { session: "p2p:mb", content: "第一条" },
            ua.user,
        )) as { id: string };
        const second = (await app.call(
            "message.send",
            { session: "p2p:mb", content: "第二条" },
            ua.user,
        )) as { id: string };
        const sent = (await app.call(
            "message.forward",
            {
                ids: [second.id, first.id],
                sessions: ["general"],
            },
            ua.user,
        )) as { content: string; kind: string }[];
        expect(sent).toHaveLength(1);
        expect(sent[0].kind).toBe("merge");
        const payload = JSON.parse(sent[0].content) as {
            merge: number;
            title: string;
            list: { content: string }[];
        };
        expect(payload.merge).toBe(1);
        expect(payload.title).toBe("2 条转发消息");
        expect(payload.list.map((m) => m.content)).toEqual([
            "第一条",
            "第二条",
        ]);
        await expect(
            app.call(
                "message.forward",
                { ids: [], sessions: ["general"] },
                ua.user,
            ),
        ).rejects.toThrow("请选择要转发的消息");
    });

    it("rejects forwarding messages the user cannot see", async () => {
        const { app, ua, ub } = await friendPair("va", "vb");
        const wc = await app.register("vc");
        await app.call("friend.request", { username: "vb" }, wc.user);
        await app.call("friend.accept", { username: "vc" }, ub.user);
        const privateMsg = (await app.call(
            "message.send",
            { session: "p2p:vb", content: "私下话" },
            wc.user,
        )) as { id: string };
        await expect(
            app.call(
                "message.forward",
                { id: privateMsg.id, sessions: ["general"] },
                ua.user,
            ),
        ).rejects.toThrow("无权转发");
    });

    it("validates forward targets and recalled source", async () => {
        const { app, ua } = await friendPair("wa", "wb");
        await expect(
            app.call(
                "message.forward",
                { id: "nope", sessions: ["general"] },
                ua.user,
            ),
        ).rejects.toThrow("消息不存在");
        const sent = (await app.call(
            "message.send",
            { session: "p2p:wb", content: "will recall" },
            ua.user,
        )) as { id: string };
        await expect(
            app.call("message.forward", { id: sent.id, sessions: [] }, ua.user),
        ).rejects.toThrow("请选择转发目标");
        await app.call("message.recall", { id: sent.id }, ua.user);
        await expect(
            app.call(
                "message.forward",
                { id: sent.id, sessions: ["p2p:wb"] },
                ua.user,
            ),
        ).rejects.toThrow("已撤回");
        const self = (await app.call(
            "message.send",
            { session: "p2p:wb", content: "copy me" },
            ua.user,
        )) as { id: string };
        await expect(
            app.call(
                "message.forward",
                { id: self.id, sessions: ["p2p:wa"] },
                ua.user,
            ),
        ).rejects.toThrow("没有有效的转发目标");
    });

    it("pages forward with after and backward with before", async () => {
        const { app, ua } = await friendPair("ya", "yb");
        const ids: string[] = [];
        for (let i = 0; i < 45; i += 1) {
            const row = (await app.call(
                "message.send",
                { session: "p2p:yb", content: `page ${i}` },
                ua.user,
            )) as { id: string };
            ids.push(row.id);
            await new Promise((done) => setTimeout(done, 2));
        }
        const tail = (await app.call(
            "history.list",
            { session: "p2p:yb", limit: 30 },
            ua.user,
        )) as { id: string; createdAt: string }[];
        expect(tail.map((m) => m.id)).toEqual(ids.slice(15));
        const older = (await app.call(
            "history.list",
            {
                session: "p2p:yb",
                limit: 10,
                before: tail[0].createdAt,
                beforeId: tail[0].id,
            },
            ua.user,
        )) as { id: string; createdAt: string }[];
        expect(older.map((m) => m.id)).toEqual(ids.slice(6, 16));
        const newer = (await app.call(
            "history.list",
            {
                session: "p2p:yb",
                limit: 10,
                after: older[older.length - 1].createdAt,
                afterId: older[older.length - 1].id,
            },
            ua.user,
        )) as { id: string }[];
        expect(newer.map((m) => m.id)).toEqual(ids.slice(15, 25));
        const fallback = (await app.call(
            "history.list",
            {
                session: "p2p:yb",
                limit: 10,
                before: tail[0].createdAt,
                beforeId: "missing-id",
            },
            ua.user,
        )) as { id: string }[];
        expect(fallback.map((m) => m.id)).toEqual(ids.slice(5, 15));
    });

    it("keeps paging exact when messages share one timestamp", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            vi.setSystemTime(new Date("2026-09-26T10:00:00.000Z"));
            const { app, ua } = await friendPair("za", "zb");
            for (let i = 0; i < 25; i += 1) {
                await app.call(
                    "message.send",
                    { session: "p2p:zb", content: `tie ${i}` },
                    ua.user,
                );
            }
            const all = (await app.call(
                "history.list",
                { session: "p2p:zb", limit: 200 },
                ua.user,
            )) as { id: string; createdAt: string }[];
            expect(new Set(all.map((m) => m.createdAt)).size).toBe(1);
            const tail = (await app.call(
                "history.list",
                { session: "p2p:zb", limit: 10 },
                ua.user,
            )) as { id: string; createdAt: string }[];
            expect(tail.map((m) => m.id)).toEqual(
                all.slice(15).map((m) => m.id),
            );
            const older = (await app.call(
                "history.list",
                {
                    session: "p2p:zb",
                    limit: 10,
                    before: all[15].createdAt,
                    beforeId: all[15].id,
                },
                ua.user,
            )) as { id: string }[];
            expect(older.map((m) => m.id)).toEqual(
                all.slice(6, 16).map((m) => m.id),
            );
            const newer = (await app.call(
                "history.list",
                {
                    session: "p2p:zb",
                    limit: 10,
                    after: all[15].createdAt,
                    afterId: all[15].id,
                },
                ua.user,
            )) as { id: string }[];
            expect(newer.map((m) => m.id)).toEqual(
                all.slice(15, 25).map((m) => m.id),
            );
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("group messaging", () => {
    const makeGroup = async (ownerName = "ga", memberName = "gb") => {
        const app = await createTestApp();
        const owner = await app.register(ownerName);
        const member = await app.register(memberName);
        const group = (await app.call(
            "group.create",
            { name: "团队", members: [memberName] },
            owner.user,
        )) as { id: string };
        return { app, owner, member, group };
    };

    it("delivers to every member and stores under g: session", async () => {
        const { app, owner, member, group } = await makeGroup();
        await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "yo" },
            owner.user,
        );
        expect(app.eventsFor(member.user.id, "message:new").length).toBe(1);
        const history = (await app.call(
            "history.list",
            { session: `g:${group.id}` },
            member.user,
        )) as { content: string }[];
        expect(history[0].content).toBe("yo");
    });

    it("rejects non-members from sending and reading", async () => {
        const { app, group } = await makeGroup("na", "nb");
        const outsider = await app.register("nc");
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "x" },
                outsider.user,
            ),
        ).rejects.toThrow("不在该群");
        await expect(
            app.call(
                "history.list",
                { session: `g:${group.id}` },
                outsider.user,
            ),
        ).rejects.toThrow("不在该群");
    });

    it("enforces member mute and mute-all with admin exemption", async () => {
        const { app, owner, member, group } = await makeGroup("ma", "mb");
        await app.call(
            "group.member.mute",
            { groupId: group.id, username: "mb", muted: true },
            owner.user,
        );
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "x" },
                member.user,
            ),
        ).rejects.toThrow("禁言");
        await app.call(
            "group.member.mute",
            { groupId: group.id, username: "mb", muted: false },
            owner.user,
        );
        await app.call(
            "group.muteAll",
            { groupId: group.id, on: true },
            owner.user,
        );
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "x" },
                member.user,
            ),
        ).rejects.toThrow("全员禁言");
        await expect(
            app.call(
                "message.send",
                { session: `g:${group.id}`, content: "admin ok" },
                owner.user,
            ),
        ).resolves.toBeTruthy();
    });

    it("lets admins recall other members' messages", async () => {
        const { app, owner, member, group } = await makeGroup("ca", "cb");
        const sent = (await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "oops" },
            member.user,
        )) as { id: string };
        await expect(
            app.call("message.recall", { id: sent.id }, member.user),
        ).resolves.toBeTruthy();
        const second = (await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "oops2" },
            member.user,
        )) as { id: string };
        await expect(
            app.call("message.recall", { id: second.id }, owner.user),
        ).resolves.toBeTruthy();
    });

    it("passes quote and mentions through to storage", async () => {
        const { app, owner, group } = await makeGroup("ta", "tb");
        const sent = (await app.call(
            "message.send",
            {
                session: `g:${group.id}`,
                content: "hi @tb",
                quote: { sender: "tb", content: "before" },
                mentions: ["tb", "tb", 123 as unknown as string],
            },
            owner.user,
        )) as { quote: unknown; mentions: string[] };
        expect(sent.quote).toEqual({ sender: "tb", content: "before" });
        expect(sent.mentions).toEqual(["tb"]);
    });
});

describe("receipts", () => {
    it("records read cursor and notifies the peer", async () => {
        const { app, ua, ub } = await friendPair("ra", "rb");
        await app.call("receipt.read", { session: "p2p:ra" }, ub.user);
        const update = app.eventsFor(ua.user.id, "receipt:update");
        expect(update).toHaveLength(1);
        const rows = (await app.call(
            "receipt.list",
            { session: "p2p:rb" },
            ua.user,
        )) as { username: string }[];
        expect(rows.map((row) => row.username)).toContain("rb");
    });
});

describe("message search", () => {
    const search = (
        app: TestApp,
        user: AuthUser,
        params: Record<string, unknown>,
    ) => app.call("message.search", params, user);

    it("searches own chats, groups and the default session", async () => {
        const { app, ua } = await friendPair("sa", "sb");
        const group = (await app.call(
            "group.create",
            { name: "搜索群", members: ["sb"] },
            ua.user,
        )) as { id: string };
        await app.call(
            "message.send",
            { session: "p2p:sb", content: "关键词私聊" },
            ua.user,
        );
        await app.call(
            "message.send",
            { session: `g:${group.id}`, content: "关键词群聊" },
            ua.user,
        );
        await app.call(
            "message.send",
            { session: "general", content: "关键词大厅" },
            ua.user,
        );
        const result = (await search(app, ua.user, { keyword: "关键词" })) as {
            hits: { content: string; session: string }[];
            total: number;
        };
        expect(result.total).toBe(3);
        expect(result.hits.map((hit) => hit.session).sort()).toEqual([
            `g:${group.id}`,
            "general",
            "p2p:sa|sb",
        ]);
    });

    it("hides other people's private sessions", async () => {
        const { app, ua, ub } = await friendPair("va", "vb");
        const outsider = await app.register("vc");
        await app.call(
            "message.send",
            { session: "p2p:va", content: "悄悄话关键词" },
            ub.user,
        );
        const mine = (await search(app, ua.user, {
            keyword: "悄悄话关键词",
        })) as {
            total: number;
        };
        expect(mine.total).toBe(1);
        const theirs = (await search(app, outsider.user, {
            keyword: "悄悄话关键词",
        })) as { total: number };
        expect(theirs.total).toBe(0);
        await expect(
            search(app, outsider.user, {
                keyword: "悄悄话关键词",
                session: "p2p:va",
            }),
        ).rejects.toThrow("只能和好友私聊");
    });

    it("scopes to a single session", async () => {
        const { app, ua } = await friendPair("wa", "wb");
        await app.call(
            "message.send",
            { session: "p2p:wb", content: "范围关键词" },
            ua.user,
        );
        await app.call(
            "message.send",
            { session: "general", content: "范围关键词" },
            ua.user,
        );
        const scoped = (await search(app, ua.user, {
            keyword: "范围关键词",
            session: "p2p:wb",
        })) as { total: number; hits: { session: string }[] };
        expect(scoped.total).toBe(1);
        expect(scoped.hits[0].session).toBe("p2p:wa|wb");
        const outsider = await app.register("wc");
        const group = (await app.call(
            "group.create",
            { name: "别人群", members: [] },
            ua.user,
        )) as { id: string };
        await expect(
            search(app, outsider.user, {
                keyword: "范围关键词",
                session: `g:${group.id}`,
            }),
        ).rejects.toThrow("不在该群");
    });

    it("matches content, skips recalled rows and pages results", async () => {
        const { app, ua } = await friendPair("xa", "xb");
        const ids: string[] = [];
        for (let i = 0; i < 5; i++)
            ids.push(
                (
                    (await app.call(
                        "message.send",
                        { session: "general", content: `分页关键词 ${i}` },
                        ua.user,
                    )) as { id: string }
                ).id,
            );
        await app.call("message.recall", { id: ids[0] }, ua.user);
        const first = (await search(app, ua.user, {
            keyword: "分页关键词",
            limit: 2,
        })) as { hits: { id: string }[]; total: number };
        expect(first.total).toBe(4);
        expect(first.hits).toHaveLength(2);
        const second = (await search(app, ua.user, {
            keyword: "分页关键词",
            limit: 2,
            offset: 2,
        })) as { hits: { id: string }[] };
        expect(second.hits).toHaveLength(2);
        expect(
            new Set([...first.hits, ...second.hits].map((hit) => hit.id)).size,
        ).toBe(4);
        const none = (await search(app, ua.user, {
            keyword: "不存在的词",
        })) as {
            total: number;
        };
        expect(none.total).toBe(0);
    });

    it("rejects empty keywords and unauthenticated callers", async () => {
        const { app, ua } = await friendPair("ya", "yb");
        await expect(search(app, ua.user, { keyword: "   " })).rejects.toThrow(
            "请输入搜索关键词",
        );
        await expect(search(app, ua.user, {})).rejects.toThrow(
            "请输入搜索关键词",
        );
        await expect(
            app.call("message.search", { keyword: "hi" }, null),
        ).rejects.toThrow("未登录");
    });
});

const HOST = "93.184.216.34";

const realTransport = linkTransport.fetch;

const stubPage = () => {
    const calls: string[] = [];
    linkTransport.fetch = async (target: URL) => {
        calls.push(target.href);
        return {
            ok: true,
            status: 200,
            headers: { get: () => "text/html; charset=utf-8" },
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            '<html><head><meta property="og:title" content="链接标题"><meta property="og:site_name" content="链接站点"></head></html>',
                        ),
                    );
                    controller.close();
                },
            }),
        };
    };
    return calls;
};

describe("chat link cards", () => {
    afterEach(() => {
        linkTransport.fetch = realTransport;
    });

    it("attaches the preview to the stored and delivered message", async () => {
        const { app, ua, ub } = await friendPair("la", "lb");
        const calls = stubPage();
        const sent = (await app.call(
            "message.send",
            { session: "p2p:lb", content: `看看 http://${HOST}/post` },
            ua.user,
        )) as { link: { title: string; site: string; url: string } | null };
        expect(calls).toEqual([`http://${HOST}/post`]);
        expect(sent.link).toMatchObject({
            title: "链接标题",
            site: "链接站点",
            url: `http://${HOST}/post`,
        });
        const event = app.eventsFor(ub.user.id, "message:new")[0] as {
            payload: { message: { link: { title: string } | null } };
        };
        expect(event.payload.message.link?.title).toBe("链接标题");
        const history = (await app.call(
            "history.list",
            { session: "p2p:la" },
            ub.user,
        )) as { link: { title: string } | null }[];
        expect(history[0].link?.title).toBe("链接标题");
    });

    it("sends the message unchanged when the preview fails", async () => {
        const { app, ua } = await friendPair("lc", "ld");
        linkTransport.fetch = async () => {
            throw new Error("boom");
        };
        const sent = (await app.call(
            "message.send",
            { session: "p2p:ld", content: `挂了 http://${HOST}/x` },
            ua.user,
        )) as { content: string; link: unknown };
        expect(sent.content).toBe(`挂了 http://${HOST}/x`);
        expect(sent.link).toBeNull();
    });

    it("never fetches for plain text or media messages", async () => {
        const { app, ua } = await friendPair("le", "lf");
        const calls = stubPage();
        await app.call(
            "message.send",
            { session: "p2p:lf", content: "普通消息 https:// 不算链接" },
            ua.user,
        );
        await app.call(
            "message.send",
            {
                session: "p2p:lf",
                content: `/files/${"a".repeat(32)}`,
                kind: "file",
                file: { name: "a.txt", size: 3 },
            },
            ua.user,
        );
        expect(calls).toEqual([]);
    });

    it("refuses to preview an internal address without failing the send", async () => {
        const { app, ua } = await friendPair("lg", "lh");
        const calls = stubPage();
        const sent = (await app.call(
            "message.send",
            { session: "p2p:lh", content: "看 http://127.0.0.1/admin" },
            ua.user,
        )) as { link: unknown };
        expect(sent.link).toBeNull();
        expect(calls).toEqual([]);
    });

    it("carries link previews for text items inside a merged forward", async () => {
        const { app, ua } = await friendPair("lk", "ll");
        stubPage();
        const first = (await app.call(
            "message.send",
            { session: "p2p:ll", content: `带链接 http://${HOST}/m1` },
            ua.user,
        )) as { id: string };
        const second = (await app.call(
            "message.send",
            { session: "p2p:ll", content: "普通一条" },
            ua.user,
        )) as { id: string };
        await app.call(
            "message.forward",
            { ids: [first.id, second.id], sessions: ["general"] },
            ua.user,
        );
        const history = (await app.call(
            "history.list",
            { session: "general" },
            ua.user,
        )) as { kind: string; content: string }[];
        const merge = history.find((item) => item.kind === "merge");
        const payload = JSON.parse(merge?.content ?? "{}") as {
            list: { content: string; link: { title: string } | null }[];
        };
        expect(payload.list).toHaveLength(2);
        expect(payload.list[0].link?.title).toBe("链接标题");
        expect(payload.list[1].link).toBeNull();
    });
});

describe("media and session guards", () => {
    it("rejects media messages that do not reference uploaded files", async () => {
        const { app, ua } = await friendPair("xa", "xb");
        await expect(
            app.call(
                "message.send",
                {
                    session: "p2p:xb",
                    content: "javascript:alert(1)",
                    kind: "file",
                    file: { name: "x.html", size: 4 },
                },
                ua.user,
            ),
        ).rejects.toThrow("媒体消息必须引用已上传的文件");
        await expect(
            app.call(
                "message.send",
                {
                    session: "p2p:xb",
                    content: "http://evil.example.com/x.png",
                    kind: "image",
                    file: { name: "x.png", size: 4 },
                },
                ua.user,
            ),
        ).rejects.toThrow("媒体消息必须引用已上传的文件");
    });

    it("normalizes an invalid media mime type", async () => {
        const { app, ua } = await friendPair("xm", "xn");
        const sent = (await app.call(
            "message.send",
            {
                session: "p2p:xn",
                content: `/files/${"b".repeat(32)}`,
                kind: "file",
                file: { name: "x.bin", size: 4, mime: "not a mime!!" },
            },
            ua.user,
        )) as { file: { mime: string } };
        expect(sent.file.mime).toBe("application/octet-stream");
    });

    it("restricts sends to p2p, group or the default session", async () => {
        const app = await createTestApp();
        const ua = await app.register("xs");
        await expect(
            app.call(
                "message.send",
                { session: "lobby2", content: "hi" },
                ua.user,
            ),
        ).rejects.toThrow("会话不存在");
        const sent = (await app.call(
            "message.send",
            { session: "general", content: "hi" },
            ua.user,
        )) as { session: string };
        expect(sent.session).toBe("general");
    });

    it("truncates oversized text content", async () => {
        const { app, ua } = await friendPair("xt", "xu");
        const sent = (await app.call(
            "message.send",
            { session: "p2p:xu", content: "好".repeat(9000) },
            ua.user,
        )) as { content: string };
        expect(sent.content).toHaveLength(8000);
    });
});

describe("chat.poke", () => {
    it("pokes a friend and mirrors a system message", async () => {
        const { app, ua, ub } = await friendPair("pka", "pkb");
        const saved = (await app.call(
            "chat.poke",
            { session: "p2p:pkb" },
            ua.user,
        )) as { kind: string; content: string; session: string };
        expect(saved.kind).toBe("system");
        expect(saved.content).toBe("pka 戳了戳 pkb");
        expect(saved.session).toBe("p2p:pkb");
        expect(app.eventsFor(ua.user.id, "message:new")).toHaveLength(1);
        const theirs = app.eventsFor(ub.user.id, "message:new");
        expect(theirs).toHaveLength(1);
        expect(
            (theirs[0] as { payload: { message: { session: string } } }).payload
                .message.session,
        ).toBe("p2p:pka");
        await expect(
            app.call("chat.poke", { session: "p2p:pkb" }, ua.user),
        ).rejects.toThrow("戳得太快了，休息一下吧");
        await expect(
            app.call("chat.poke", { session: "general" }, ua.user),
        ).rejects.toThrow("该会话不支持戳一戳");
    });

    it("requires friendship and group membership for targets", async () => {
        const app = await createTestApp();
        const ua = await app.register("pkc");
        await app.register("pkd");
        const mem = await app.register("pke");
        await expect(
            app.call("chat.poke", { session: "p2p:pkd" }, ua.user),
        ).rejects.toThrow("只能和好友私聊");
        const group = (await app.call(
            "group.create",
            { name: "戳戳群", members: ["pke"] },
            ua.user,
        )) as { id: string };
        const targeted = (await app.call(
            "chat.poke",
            { session: `g:${group.id}`, target: "pke" },
            ua.user,
        )) as { content: string };
        expect(targeted.content).toBe("pkc 戳了戳 pke");
        await expect(
            app.call(
                "chat.poke",
                { session: `g:${group.id}`, target: "pkd" },
                ua.user,
            ),
        ).rejects.toThrow("对方不在该群中");
        const broadcast = (await app.call(
            "chat.poke",
            { session: `g:${group.id}` },
            mem.user,
        )) as { content: string };
        expect(broadcast.content).toBe("pke 戳了戳大家");
        const groupPokes = app.events.filter(
            (event) =>
                event.name === "message:new" &&
                (event.payload as { message: { session: string } }).message
                    .session === `g:${group.id}`,
        );
        expect(groupPokes).toHaveLength(4);
    });
});
