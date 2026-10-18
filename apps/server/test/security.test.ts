import { describe, expect, it } from "vitest";
import {
    deviceLabelOf,
    generateTotpSecret,
    totpAt,
    verifyTotp,
} from "../src/plugins/auth";
import {
    dndNextStart,
    dndWindowActive,
    normalizeDnd,
} from "../src/plugins/push";
import { createTestApp } from "./helpers";

describe("TOTP", () => {
    it("generates a base32 secret", () => {
        const secret = generateTotpSecret();
        expect(secret).toMatch(/^[A-Z2-7]{32}$/);
        expect(generateTotpSecret()).not.toBe(secret);
    });

    it("verifies the current code and rejects neighbours", () => {
        const secret = generateTotpSecret();
        const now = 1_700_000_000_000;
        const counter = Math.floor(now / 1000 / 30);
        expect(verifyTotp(secret, totpAt(secret, counter), now)).toBe(true);
        expect(verifyTotp(secret, totpAt(secret, counter - 3), now)).toBe(
            false,
        );
        expect(verifyTotp(secret, "00000x", now)).toBe(false);
        expect(verifyTotp(secret, "", now)).toBe(false);
    });

    it("labels devices from user agent", () => {
        expect(deviceLabelOf("")).toBe("未知设备");
        expect(
            deviceLabelOf(
                "Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36",
            ),
        ).toBe("Chrome Windows");
        expect(deviceLabelOf("curl/8.0")).toBe("curl");
    });
});

describe("免打扰时段", () => {
    const at = (hour: number, minute = 0) =>
        new Date(2026, 0, 1, hour, minute, 0);

    it("normalizes invalid input to defaults", () => {
        expect(normalizeDnd(null)).toEqual({
            enabled: false,
            start: "22:00",
            end: "08:00",
            mutedSessions: [],
        });
        const parsed = normalizeDnd({
            enabled: true,
            start: "99:99",
            end: "7:00",
            mutedSessions: ["g:1", 5, "g:1"],
        });
        expect(parsed.start).toBe("22:00");
        expect(parsed.end).toBe("08:00");
        expect(parsed.mutedSessions).toEqual(["g:1"]);
    });

    it("handles windows that cross midnight", () => {
        const settings = {
            enabled: true,
            start: "22:00",
            end: "08:00",
            mutedSessions: [],
        };
        expect(dndWindowActive(settings, at(23))).toBe(true);
        expect(dndWindowActive(settings, at(3))).toBe(true);
        expect(dndWindowActive(settings, at(12))).toBe(false);
        expect(dndWindowActive({ ...settings, enabled: false }, at(23))).toBe(
            false,
        );
        expect(dndWindowActive({ ...settings, start: "09:00" }, at(9))).toBe(
            true,
        );
        expect(
            dndWindowActive(
                { ...settings, start: "09:00", end: "18:00" },
                at(12),
            ),
        ).toBe(true);
    });

    it("computes next start", () => {
        const settings = {
            enabled: true,
            start: "22:00",
            end: "08:00",
            mutedSessions: [],
        };
        expect(dndNextStart(settings, at(12))).toBeTruthy();
        expect(dndNextStart(settings, at(23))).toBeNull();
        expect(
            dndNextStart({ ...settings, enabled: false }, at(12)),
        ).toBeNull();
    });

    it("persists dnd settings over rpc", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const initial = (await app.call("dnd.get", {}, alice.user)) as {
            settings: { enabled: boolean };
        };
        expect(initial.settings.enabled).toBe(false);

        const saved = (await app.call(
            "dnd.set",
            { enabled: true, start: "23:00", end: "07:30" },
            alice.user,
        )) as { settings: { start: string }; active: boolean };
        expect(saved.settings.start).toBe("23:00");

        const muted = (await app.call(
            "dnd.mute",
            { session: "g:room", on: true },
            alice.user,
        )) as { settings: { mutedSessions: string[] } };
        expect(muted.settings.mutedSessions).toEqual(["g:room"]);

        const again = (await app.call(
            "dnd.mute",
            { session: "g:room", on: false },
            alice.user,
        )) as { settings: { mutedSessions: string[] } };
        expect(again.settings.mutedSessions).toEqual([]);
    });
});

describe("多端设备", () => {
    it("records a session per login and lists them", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const first = (await app.call("auth.sessions", {}, alice.user)) as {
            devices: { id: string; current: boolean }[];
        };
        expect(first.devices.length).toBe(1);
        expect(first.devices[0].current).toBe(false);

        await app.login("alice");
        await app.login("alice");
        const all = (await app.call("auth.sessions", {}, alice.user)) as {
            devices: unknown[];
        };
        expect(all.devices.length).toBe(3);
    });

    it("binds session id into the token and rejects revoked ones", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const verified = await app.verify(alice.token);
        expect(verified?.sessionId).toBeTruthy();

        const list = (await app.call("auth.sessions", {}, alice.user)) as {
            devices: { id: string; current: boolean }[];
        };
        const mine = list.devices[0];
        await expect(
            app.call(
                "auth.session.revoke",
                { id: mine.id },
                { ...alice.user, sessionId: "other" },
            ),
        ).resolves.toEqual({ ok: true });
        expect(await app.verify(alice.token)).toBeNull();
    });

    it("refuses to revoke the current device directly", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const list = (await app.call("auth.sessions", {}, alice.user)) as {
            devices: { id: string }[];
        };
        await expect(
            app.call(
                "auth.session.revoke",
                { id: list.devices[0].id },
                { ...alice.user, sessionId: list.devices[0].id },
            ),
        ).rejects.toThrow("不能下线当前设备");
    });

    it("revokes every other device", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        await app.login("alice");
        await app.login("alice");

        const list = (await app.call("auth.sessions", {}, alice.user)) as {
            devices: { id: string }[];
        };
        const keep = list.devices[0].id;
        const result = (await app.call(
            "auth.sessions.revokeOthers",
            {},
            { ...alice.user, sessionId: keep },
        )) as { revoked: number };
        expect(result.revoked).toBe(2);
        expect(await app.verify(alice.token)).toBeNull();

        const rest = (await app.call(
            "auth.sessions",
            {},
            { ...alice.user, sessionId: keep },
        )) as { devices: unknown[] };
        expect(rest.devices.length).toBe(1);
    });

    it("enables totp and then requires it at login", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const setup = (await app.call("auth.totp.setup", {}, alice.user)) as {
            secret: string;
            otpauth: string;
        };
        expect(setup.otpauth).toContain("otpauth://totp/");

        const code = totpAt(setup.secret, Math.floor(Date.now() / 1000 / 30));
        const enabled = (await app.call(
            "auth.totp.enable",
            { code },
            alice.user,
        )) as { totpEnabled: boolean };
        expect(enabled.totpEnabled).toBe(true);

        await expect(app.login("alice")).rejects.toThrow("动态口令");
        const ok = await app.call("auth.login", {
            username: "alice",
            password: "Passw0rd!",
            totp: totpAt(setup.secret, Math.floor(Date.now() / 1000 / 30)),
        });
        expect(ok).toHaveProperty("token");
    });

    it("rejects a wrong totp code when enabling", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        await app.call("auth.totp.setup", {}, alice.user);
        await expect(
            app.call("auth.totp.enable", { code: "000000" }, alice.user),
        ).rejects.toThrow("动态口令不正确");
    });
});

describe("机器人 / 开放 API", () => {
    it("creates an app and rejects a bad token", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const created = (await app.call(
            "bots.app.create",
            { name: "CI", scopes: ["messages:write"] },
            alice.user,
        )) as { token: string; scopes: string[]; name: string };
        expect(created.token).toMatch(/^pgm_/);
        expect(created.scopes).toEqual(["messages:write"]);

        const bad = await app.app.request("/open/whoami", {
            headers: {
                authorization: "Bearer pgm_bogusbogusbogusbogusbogusbogus",
            },
        });
        expect(bad.status).toBe(401);

        const good = await app.app.request("/open/whoami", {
            headers: { authorization: `Bearer ${created.token}` },
        });
        expect(good.status).toBe(200);
        const body = (await good.json()) as { result: { name: string } };
        expect(body.result.name).toBe("CI");
    });

    it("delivers inbound messages into a group the owner belongs to", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const bob = await app.register("bob");
        await app.call("friend.request", { username: "bob" }, alice.user);
        await app.call("friend.accept", { username: "alice" }, bob.user);
        const group = (await app.call(
            "group.create",
            { name: "研发" },
            alice.user,
        )) as { id: string };

        const created = (await app.call(
            "bots.app.create",
            { name: "CI", scopes: ["messages:write"] },
            alice.user,
        )) as { token: string };

        const res = await app.app.request("/open/message", {
            method: "POST",
            headers: {
                authorization: `Bearer ${created.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                session: `g:${group.id}`,
                title: "构建",
                content: "main 构建成功",
                kind: "notice",
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            ok: boolean;
            result: { id: string };
        };
        expect(body.ok).toBe(true);

        const history = (await app.call(
            "history.list",
            { session: `g:${group.id}` },
            alice.user,
        )) as { content: string; kind: string }[];
        expect(history.at(-1)?.content).toBe("【构建】\nmain 构建成功");
        expect(history.at(-1)?.kind).toBe("notice");
    });

    it("refuses inbound messages to a group the owner is not in", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const bob = await app.register("bob");
        const group = (await app.call(
            "group.create",
            { name: "研发" },
            bob.user,
        )) as { id: string };
        const created = (await app.call(
            "bots.app.create",
            { name: "CI" },
            alice.user,
        )) as { token: string };

        const res = await app.app.request("/open/message", {
            method: "POST",
            headers: {
                authorization: `Bearer ${created.token}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                session: `g:${group.id}`,
                content: "hi",
            }),
        });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { message: string };
        expect(body.message).toContain("不在该群中");
    });

    it("enforces scopes and rejects unknown sessions", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const readOnly = (await app.call(
            "bots.app.create",
            { name: "Reader", scopes: ["messages:read"] },
            alice.user,
        )) as { token: string };

        const denied = await app.app.request("/open/message", {
            method: "POST",
            headers: { authorization: `Bearer ${readOnly.token}` },
            body: JSON.stringify({ session: "g:x", content: "hi" }),
        });
        expect(denied.status).toBe(403);

        const writer = (await app.call(
            "bots.app.create",
            { name: "Writer" },
            alice.user,
        )) as { token: string };
        const badSession = await app.app.request("/open/message", {
            method: "POST",
            headers: { authorization: `Bearer ${writer.token}` },
            body: JSON.stringify({ session: "weird:1", content: "hi" }),
        });
        expect(badSession.status).toBe(400);
    });

    it("revokes an app so its token stops working", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const created = (await app.call(
            "bots.app.create",
            { name: "CI" },
            alice.user,
        )) as { token: string; id: string };
        await app.call("bots.app.revoke", { id: created.id }, alice.user);
        const res = await app.app.request("/open/whoami", {
            headers: { authorization: `Bearer ${created.token}` },
        });
        expect(res.status).toBe(401);
    });

    it("validates hook creation", async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        await app.call("bots.app.create", { name: "CI" }, alice.user);
        await expect(
            app.call(
                "bots.hook.create",
                { url: "ftp://x", events: ["message.new"] },
                alice.user,
            ),
        ).rejects.toThrow("http(s)");
        await expect(
            app.call(
                "bots.hook.create",
                { url: "https://ci.example.com/h", events: [] },
                alice.user,
            ),
        ).rejects.toThrow("事件");
        const hook = (await app.call(
            "bots.hook.create",
            {
                url: "https://ci.example.com/hook",
                events: ["message.new", "nope"],
            },
            alice.user,
        )) as { events: string[]; secret: string };
        expect(hook.events).toEqual(["message.new"]);
        expect(hook.secret.length).toBeGreaterThan(16);

        const hooks = (await app.call("bots.hooks", {}, alice.user)) as {
            id: string;
            enabled: boolean;
        }[];
        expect(hooks.length).toBe(1);
        await app.call(
            "bots.hook.toggle",
            { id: hooks[0].id, enabled: false },
            alice.user,
        );
        const after = (await app.call("bots.hooks", {}, alice.user)) as {
            enabled: boolean;
        }[];
        expect(after[0].enabled).toBe(false);
        await app.call("bots.hook.remove", { id: hooks[0].id }, alice.user);
        expect(
            (await app.call("bots.hooks", {}, alice.user)) as unknown[],
        ).toHaveLength(0);
    });
});

describe("message.edit", () => {
    const setup = async () => {
        const app = await createTestApp();
        const alice = await app.register("alice");
        const bob = await app.register("bob");
        await app.call("friend.request", { username: "bob" }, alice.user);
        await app.call("friend.accept", { username: "alice" }, bob.user);
        return { app, alice, bob };
    };

    it("edits own text message and marks it", async () => {
        const { app, alice, bob } = await setup();
        const sent = (await app.call(
            "message.send",
            { session: "p2p:bob", content: "原内容" },
            alice.user,
        )) as { id: string };

        const result = (await app.call(
            "message.edit",
            { id: sent.id, content: "改过的内容" },
            alice.user,
        )) as {
            message: { content: string; editedAt: string | null };
            editCount: number;
        };
        expect(result.message.content).toBe("改过的内容");
        expect(result.message.editedAt).toBeTruthy();
        expect(result.editCount).toBe(1);

        const history = (await app.call(
            "history.list",
            { session: "p2p:alice" },
            bob.user,
        )) as { id: string; content: string; editCount: number }[];
        const row = history.find((m) => m.id === sent.id);
        expect(row?.content).toBe("改过的内容");
        expect(row?.editCount).toBe(1);

        const second = (await app.call(
            "message.edit",
            { id: sent.id, content: "再改一次" },
            alice.user,
        )) as { editCount: number };
        expect(second.editCount).toBe(2);
    });

    it("rejects editing others messages and non-text", async () => {
        const { app, alice, bob } = await setup();
        const sent = (await app.call(
            "message.send",
            { session: "p2p:bob", content: "hello" },
            alice.user,
        )) as { id: string };
        await expect(
            app.call(
                "message.edit",
                { id: sent.id, content: "hack" },
                bob.user,
            ),
        ).rejects.toThrow("只能编辑自己的消息");

        await expect(
            app.call("message.edit", { id: sent.id, content: "" }, alice.user),
        ).rejects.toThrow("不能为空");
        await expect(
            app.call(
                "message.edit",
                { id: sent.id, content: "hello" },
                alice.user,
            ),
        ).rejects.toThrow("没有变化");
        await expect(
            app.call(
                "message.edit",
                { id: "missing", content: "x" },
                alice.user,
            ),
        ).rejects.toThrow("消息不存在");
    });

    it("rejects editing recalled messages", async () => {
        const { app, alice } = await setup();
        const sent = (await app.call(
            "message.send",
            { session: "p2p:bob", content: "hello" },
            alice.user,
        )) as { id: string };
        await app.call("message.recall", { id: sent.id }, alice.user);
        await expect(
            app.call(
                "message.edit",
                { id: sent.id, content: "later" },
                alice.user,
            ),
        ).rejects.toThrow("已撤回");
    });

    it("broadcasts message:edited", async () => {
        const { app, alice } = await setup();
        const sent = (await app.call(
            "message.send",
            { session: "p2p:bob", content: "a" },
            alice.user,
        )) as { id: string };
        await app.call(
            "message.edit",
            { id: sent.id, content: "b" },
            alice.user,
        );
        const edited = app.events.filter(
            (event) => event.name === "message:edited",
        );
        expect(edited.length).toBe(1);
    });
});
