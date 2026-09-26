import type { ChatMessage, GroupFileItem, GroupInfo } from "@plugim/protocol";
import { describe, expect, it } from "vitest";
import type { GroupFilesStore, MediaFilesStore } from "../src/types";
import { createTestApp, uploadFile } from "./helpers";

const setup = async () => {
    const app = await createTestApp({ admins: ["root"] });
    const root = await app.register("root");
    const owner = await app.register("own");
    const admin = await app.register("adm");
    const member = await app.register("mem");
    const stranger = await app.register("str");
    const group = (await app.call(
        "group.create",
        { name: "资料群", members: ["adm", "mem"] },
        owner.user,
    )) as GroupInfo;
    await app.call(
        "group.member.role",
        { groupId: group.id, username: "adm", role: "admin" },
        owner.user,
    );
    return { app, root, owner, admin, member, stranger, group };
};

type App = Awaited<ReturnType<typeof createTestApp>>;

const listOf = async (app: App, groupId: string, user: { id: string }) =>
    (await app.call("group.file.list", { groupId }, user as never)) as {
        files: GroupFileItem[];
        total: number;
    };

const share = async (
    app: App,
    groupId: string,
    user: { user: { id: string }; token: string },
    name = "方案.docx",
) => {
    const uploaded = await uploadFile(
        app,
        user.token,
        name,
        "application/vnd.ms-word",
        24,
    );
    await app.call("group.file.add", { groupId, key: uploaded.key }, user.user);
    return uploaded;
};

const age = (days: number) =>
    new Date(Date.now() - days * 86_400_000).toISOString();

describe("group files", () => {
    it("shares an uploaded file with every member and posts a notice", async () => {
        const { app, owner, member, group } = await setup();
        const uploaded = await share(app, group.id, owner);
        const list = await listOf(app, group.id, member.user);
        expect(list.total).toBe(1);
        expect(list.files[0]).toMatchObject({
            key: uploaded.key,
            name: "方案.docx",
            size: 24,
            uploader: "own",
        });
        const history = (await app.call(
            "history.list",
            { session: `g:${group.id}` },
            member.user,
        )) as ChatMessage[];
        expect(history.at(-1)).toMatchObject({
            sender: "own",
            kind: "file",
            content: uploaded.url,
            file: { name: "方案.docx", size: 24 },
        });
        expect(
            app.eventsFor(member.user.id, "group:update").at(-1)?.payload,
        ).toEqual({ groupId: group.id });
    });

    it("hides files from strangers and refuses foreign keys", async () => {
        const { app, owner, member, stranger, group } = await setup();
        await share(app, group.id, owner);
        await expect(listOf(app, group.id, stranger.user)).rejects.toThrow(
            "不在该群",
        );
        await expect(listOf(app, "nope", member.user)).rejects.toThrow(
            "群组不存在",
        );
        const mine = await uploadFile(
            app,
            member.token,
            "私密.txt",
            "text/plain",
            4,
        );
        await expect(
            app.call(
                "group.file.add",
                { groupId: group.id, key: mine.key },
                stranger.user,
            ),
        ).rejects.toThrow("不在该群");
        const theirs = await uploadFile(
            app,
            owner.token,
            "别人的.txt",
            "text/plain",
            4,
        );
        await expect(
            app.call(
                "group.file.add",
                { groupId: group.id, key: theirs.key },
                member.user,
            ),
        ).rejects.toThrow("只能添加自己上传的文件");
        await expect(
            app.call(
                "group.file.add",
                { groupId: group.id, key: "../../etc/passwd" },
                member.user,
            ),
        ).rejects.toThrow("文件不存在");
        await expect(
            app.call(
                "group.file.add",
                { groupId: group.id, key: "a".repeat(32) },
                member.user,
            ),
        ).rejects.toThrow("文件不存在");
    });

    it("lets only the uploader or group staff delete", async () => {
        const { app, owner, admin, member, group } = await setup();
        const byMember = await share(app, group.id, member, "成员版.txt");
        const byOwner = await share(app, group.id, owner, "群主版.txt");
        await expect(
            app.call(
                "group.file.delete",
                { groupId: group.id, key: byMember.key },
                admin.user,
            ),
        ).resolves.toBe(true);
        await expect(
            app.call(
                "group.file.delete",
                { groupId: group.id, key: byOwner.key },
                member.user,
            ),
        ).rejects.toThrow("只有上传者或群管理可以删除");
        await expect(
            app.call(
                "group.file.delete",
                { groupId: group.id, key: byOwner.key },
                owner.user,
            ),
        ).resolves.toBe(true);
        await expect(
            app.call(
                "group.file.delete",
                { groupId: group.id, key: byOwner.key },
                owner.user,
            ),
        ).rejects.toThrow("文件不存在");
        expect((await listOf(app, group.id, member.user)).total).toBe(0);
    });

    it("keeps blobs while other groups or messages reference them", async () => {
        const { app, owner, group } = await setup();
        const second = (await app.call(
            "group.create",
            { name: "另一个群", members: ["mem"] },
            owner.user,
        )) as GroupInfo;
        const shared = await share(app, group.id, owner);
        await app.call(
            "group.file.add",
            { groupId: second.id, key: shared.key },
            owner.user,
        );
        await app.call(
            "group.file.delete",
            { groupId: group.id, key: shared.key },
            owner.user,
        );
        const store = app.ctx.get<GroupFilesStore>("groupFiles");
        const media = app.ctx.get<MediaFilesStore>("mediaFiles");
        expect(await store.countByKey(shared.key)).toBe(1);
        expect((await listOf(app, second.id, owner.user)).total).toBe(1);
        expect((await app.app.request(shared.url)).status).toBe(200);
        const afterNotice = await app.call(
            "group.file.delete",
            { groupId: second.id, key: shared.key },
            owner.user,
        );
        expect(afterNotice).toBe(true);
        expect(await store.countByKey(shared.key)).toBe(0);
        expect(await media.byKey(shared.key)).toBeTruthy();
        expect((await app.app.request(shared.url)).status).toBe(200);
    });

    it("removes the blob once nothing references it", async () => {
        const { app, owner, group } = await setup();
        const uploaded = await uploadFile(
            app,
            owner.token,
            "孤儿.bin",
            "application/octet-stream",
            7,
        );
        const store = app.ctx.get<GroupFilesStore>("groupFiles");
        await store.save({
            groupId: group.id,
            key: uploaded.key,
            name: "孤儿.bin",
            mime: "application/octet-stream",
            size: 7,
            uploaderId: owner.user.id,
            createdAt: age(0),
        });
        await app.call(
            "group.file.delete",
            { groupId: group.id, key: uploaded.key },
            owner.user,
        );
        const media = app.ctx.get<MediaFilesStore>("mediaFiles");
        expect(await media.byKey(uploaded.key)).toBeNull();
        expect((await app.app.request(uploaded.url)).status).toBe(404);
    });

    it("spares group files from the orphan sweep", async () => {
        const { app, root, owner, group } = await setup();
        const media = app.ctx.get<MediaFilesStore>("mediaFiles");
        const store = app.ctx.get<GroupFilesStore>("groupFiles");
        const kept = "c".repeat(32);
        const orphan = "d".repeat(32);
        for (const [key, name] of [
            [kept, "群文件.txt"],
            [orphan, "孤儿.txt"],
        ] as const) {
            await media.save({
                key,
                name,
                mime: "text/plain",
                size: 4,
                uploaderId: owner.user.id,
                createdAt: age(3),
            });
        }
        await store.save({
            groupId: group.id,
            key: kept,
            name: "群文件.txt",
            mime: "text/plain",
            size: 4,
            uploaderId: owner.user.id,
            createdAt: age(3),
        });
        const run = (await app.call(
            "admin.task.run",
            { name: "media-sweep" },
            root.user,
        )) as { lastStatus: string; lastMessage: string };
        expect(run.lastStatus).toBe("ok");
        expect(run.lastMessage).toContain("1");
        expect(await media.byKey(kept)).toBeTruthy();
        expect(await media.byKey(orphan)).toBeNull();
        expect((await listOf(app, group.id, owner.user)).total).toBe(1);
    });

    it("pages and orders the file list by upload time", async () => {
        const { app, owner, member, group } = await setup();
        const keys: string[] = [];
        for (const name of ["一.txt", "二.txt", "三.txt"]) {
            const uploaded = await uploadFile(
                app,
                owner.token,
                name,
                "text/plain",
                3,
            );
            await app.call(
                "group.file.add",
                { groupId: group.id, key: uploaded.key },
                owner.user,
            );
            keys.push(uploaded.key);
            await new Promise((done) => setTimeout(done, 2));
        }
        const first = (await app.call(
            "group.file.list",
            { groupId: group.id, limit: 2 },
            member.user,
        )) as { files: GroupFileItem[]; total: number };
        expect(first.total).toBe(3);
        expect(first.files.map((file) => file.name)).toEqual([
            "三.txt",
            "二.txt",
        ]);
        const second = (await app.call(
            "group.file.list",
            { groupId: group.id, offset: 2, limit: 2 },
            member.user,
        )) as { files: GroupFileItem[]; total: number };
        expect(second.files.map((file) => file.name)).toEqual(["一.txt"]);
        expect(second.files[0].key).toBe(keys[0]);
    });

    it("drops rows with the group and blocks admin file deletion", async () => {
        const { app, root, owner, group } = await setup();
        const uploaded = await uploadFile(
            app,
            owner.token,
            "被引用.txt",
            "text/plain",
            6,
        );
        const store = app.ctx.get<GroupFilesStore>("groupFiles");
        const media = app.ctx.get<MediaFilesStore>("mediaFiles");
        await store.save({
            groupId: group.id,
            key: uploaded.key,
            name: "被引用.txt",
            mime: "text/plain",
            size: 6,
            uploaderId: owner.user.id,
            createdAt: age(0),
        });
        await expect(
            app.call("admin.files.delete", { key: uploaded.key }, root.user),
        ).rejects.toThrow("仍被群文件引用");
        await app.call("admin.group.delete", { groupId: group.id }, root.user);
        expect(await store.countByKey(uploaded.key)).toBe(0);
        expect(await media.byKey(uploaded.key)).toBeTruthy();
        await app.call("admin.files.delete", { key: uploaded.key }, root.user);
        expect(await media.byKey(uploaded.key)).toBeNull();
        expect((await app.app.request(uploaded.url)).status).toBe(404);
    });

    it("requires a session", async () => {
        const { app, group } = await setup();
        await expect(
            app.call("group.file.list", { groupId: group.id }),
        ).rejects.toThrow("未登录");
    });
});
