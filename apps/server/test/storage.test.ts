import { describe, expect, it } from "vitest";
import type {
    AccountsStore,
    GroupsStore,
    MessageStore,
    ReadsStore,
} from "../src/types";
import { createTestApp } from "./helpers";

const stores = async (app: { ctx: { get<T>(n: string): T } }) => ({
    messages: app.ctx.get<MessageStore>("store"),
    accounts: app.ctx.get<AccountsStore>("accounts"),
    groups: app.ctx.get<GroupsStore>("groups"),
    reads: app.ctx.get<ReadsStore>("reads"),
});

describe("message store", () => {
    it("round-trips quote, mentions, kind and file metadata", async () => {
        const app = await createTestApp();
        const { messages } = await stores(app);
        const saved = await messages.save({
            session: "g:1",
            sender: "a",
            content: "hi @b",
            quote: { sender: "b", content: "earlier" },
            mentions: ["b"],
            kind: "text",
            file: null,
        });
        expect(saved.quote).toEqual({ sender: "b", content: "earlier" });
        expect(saved.mentions).toEqual(["b"]);
        const loaded = await messages.byId(saved.id);
        expect(loaded?.content).toBe("hi @b");
        expect(loaded?.quote).toEqual({ sender: "b", content: "earlier" });
        expect(loaded?.mentions).toEqual(["b"]);
    });

    it("stores file payloads and null metadata", async () => {
        const app = await createTestApp();
        const { messages } = await stores(app);
        const withFile = await messages.save({
            session: "s",
            sender: "a",
            content: "data:application/pdf;base64,x",
            kind: "file",
            file: { name: "doc.pdf", size: 10 },
        });
        expect(withFile.file).toEqual({ name: "doc.pdf", size: 10 });
        const plain = await messages.save({
            session: "s",
            sender: "a",
            content: "text",
        });
        expect(plain.file).toBeNull();
    });

    it("lists newest-first with before pagination", async () => {
        const app = await createTestApp();
        const { messages } = await stores(app);
        const ids: string[] = [];
        for (let i = 0; i < 5; i++) {
            const saved = await messages.save({
                session: "page",
                sender: "a",
                content: `m${i}`,
            });
            ids.push(saved.id);
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const all = await messages.list("page", 10);
        expect(all.map((m) => m.content)).toEqual([
            "m0",
            "m1",
            "m2",
            "m3",
            "m4",
        ]);
        const older = await messages.list("page", 2, all[2].createdAt);
        expect(older.map((m) => m.content)).toEqual(["m0", "m1"]);
    });

    it("marks messages recalled", async () => {
        const app = await createTestApp();
        const { messages } = await stores(app);
        const saved = await messages.save({
            session: "r",
            sender: "a",
            content: "x",
        });
        const at = await messages.markRecalled(saved.id);
        expect(at).toBeTruthy();
        const loaded = await messages.byId(saved.id);
        expect(loaded?.recalledAt).toBe(at);
        expect(await messages.markRecalled("missing")).toBeNull();
    });
});

describe("accounts store", () => {
    it("makes the very first user an admin", async () => {
        const app = await createTestApp();
        const { accounts } = await stores(app);
        const first = await accounts.create("first", "hash");
        const row = await accounts.fullById(first.id);
        expect(row?.isAdmin).toBe(true);
        const second = await accounts.create("second", "hash");
        expect((await accounts.fullById(second.id))?.isAdmin).toBe(false);
    });

    it("lists users and toggles flags", async () => {
        const app = await createTestApp();
        const { accounts } = await stores(app);
        const a = await accounts.create("aa", "hash");
        await accounts.create("bb", "hash");
        expect((await accounts.listAll()).map((u) => u.username)).toEqual(
            expect.arrayContaining(["aa", "bb"]),
        );
        await accounts.setFlag(a.id, "banned", true);
        expect((await accounts.fullById(a.id))?.banned).toBe(true);
        expect(await accounts.count()).toBe(2);
    });
});

describe("groups store", () => {
    it("manages membership, roles and mute flags", async () => {
        const app = await createTestApp();
        const { groups, accounts } = await stores(app);
        const owner = await accounts.create("owner", "hash");
        const member = await accounts.create("member", "hash");
        const group = await groups.create("team", owner.id);
        await groups.addMember(group.id, owner.id);
        await groups.setRole(group.id, owner.id, "owner");
        await groups.addMember(group.id, member.id);
        await groups.setMuted(group.id, member.id, true);

        const members = await groups.membersOf(group.id);
        expect(members.find((m) => m.userId === owner.id)?.role).toBe("owner");
        expect(members.find((m) => m.userId === member.id)?.muted).toBe(true);
        expect((await groups.groupsOf(member.id)).map((g) => g.id)).toEqual([
            group.id,
        ]);
        expect(await groups.shareGroup(owner.id, member.id)).toBe(true);
        expect(await groups.memberIdsOf(group.id)).toHaveLength(2);

        await groups.remove(group.id);
        expect(await groups.byId(group.id)).toBeNull();
        expect(await groups.membersOf(group.id)).toHaveLength(0);
    });

    it("updates notice and mute-all settings", async () => {
        const app = await createTestApp();
        const { groups, accounts } = await stores(app);
        const owner = await accounts.create("o2", "hash");
        const group = await groups.create("g2", owner.id);
        await groups.setNotice(group.id, "hello");
        await groups.setMuteAll(group.id, true);
        await groups.rename(group.id, "renamed");
        const row = await groups.byId(group.id);
        expect(row).toMatchObject({
            name: "renamed",
            notice: "hello",
            muteAll: true,
        });
    });
});

describe("reads store", () => {
    it("upserts read cursors per user and session", async () => {
        const app = await createTestApp();
        const { reads, accounts } = await stores(app);
        const a = await accounts.create("ra", "hash");
        const b = await accounts.create("rb", "hash");
        const t1 = new Date(Date.now() - 1000).toISOString();
        const t2 = new Date().toISOString();
        await reads.set(a.id, "p2p:a|b", t1);
        await reads.set(a.id, "p2p:a|b", t2);
        await reads.set(b.id, "p2p:a|b", t1);
        const rows: { userId: string; at: string }[] =
            await reads.ofSession("p2p:a|b");
        const forA = rows.find((row) => row.userId === a.id);
        expect(forA?.at).toBe(t2);
        expect(rows).toHaveLength(2);
    });
});
