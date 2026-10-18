import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@plugim/core";
import type { Envelope } from "@plugim/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { adminPlugin } from "../src/plugins/admin";
import { auditPlugin } from "../src/plugins/audit";
import { authPlugin } from "../src/plugins/auth";
import { botsPlugin } from "../src/plugins/bots";
import { chatPlugin } from "../src/plugins/chat";
import type { AppConfig } from "../src/plugins/config";
import { filesPlugin } from "../src/plugins/files";
import { friendsPlugin } from "../src/plugins/friends";
import { gatewayPlugin } from "../src/plugins/gateway";
import { groupPlugin } from "../src/plugins/group";
import { groupFilesPlugin } from "../src/plugins/group-files";
import { linkPreviewPlugin } from "../src/plugins/link-preview";
import { momentsPlugin } from "../src/plugins/moments";
import { orgPlugin } from "../src/plugins/org";
import { pushPlugin } from "../src/plugins/push";
import { screenPlugin } from "../src/plugins/screen";
import { stickersPlugin } from "../src/plugins/stickers";
import { storagePlugin } from "../src/plugins/storage";
import { tasksPlugin } from "../src/plugins/tasks";

interface LiveServer {
    port: number;
    base: string;
    call(
        method: string,
        params?: Record<string, unknown>,
        token?: string | null,
    ): Promise<unknown>;
    stop(): Promise<void>;
}

const servers: LiveServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
    for (const socket of sockets.splice(0)) {
        try {
            socket.close();
        } catch {}
    }
    for (const server of servers.splice(0)) {
        await server.stop();
    }
});

const freePort = async (): Promise<number> => {
    const probe = await import("node:net");
    return new Promise((resolve, reject) => {
        const srv = probe.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const address = srv.address();
            const port =
                typeof address === "object" && address ? address.port : 0;
            srv.close(() => resolve(port));
        });
    });
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const startServer = async (dbFile: string): Promise<LiveServer> => {
    const port = await freePort();
    const ctx = new Context();
    ctx.provide<AppConfig>("config", {
        port,
        dbDriver: "sqlite",
        dbUrl: "",
        dbFile,
        logDir: "",
        defaultSession: "general",
        jwtSecret: "e2e-secret",
        bootstrapAdmins: [],
        allowRegister: true,
        inviteCode: "",
        vapidPublicKey: "",
        vapidPrivateKey: "",
        vapidSubject: "",
        iceServers: [],
        storageDriver: "local",
        storageDir: join(dbFile, "..", "uploads"),
        uploadLimitMb: 20,
        s3Endpoint: "",
        s3Region: "",
        s3Bucket: "",
        s3AccessKey: "",
        s3SecretKey: "",
        s3PathStyle: "",
        s3PublicBase: "",
        linkAllowHosts: [],
        linkDenyHosts: [],
    });

    ctx.plugin(storagePlugin);
    ctx.plugin(tasksPlugin);
    ctx.plugin(auditPlugin);
    ctx.plugin(pushPlugin);
    ctx.plugin(linkPreviewPlugin);
    ctx.plugin(filesPlugin);
    ctx.plugin(authPlugin);
    ctx.plugin(friendsPlugin);
    ctx.plugin(groupFilesPlugin);
    ctx.plugin(groupPlugin);
    ctx.plugin(botsPlugin);
    ctx.plugin(chatPlugin);
    ctx.plugin(momentsPlugin);
    ctx.plugin(screenPlugin);
    ctx.plugin(orgPlugin);
    ctx.plugin(stickersPlugin);
    ctx.plugin(adminPlugin);
    ctx.plugin(gatewayPlugin);
    await ctx.start();

    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try {
            const res = await fetch(`${base}/health`);
            if (res.ok) break;
        } catch {}
        await wait(100);
    }

    const call: LiveServer["call"] = async (
        method,
        params = {},
        token = null,
    ) => {
        const res = await fetch(`${base}/rpc/${method}`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ params }),
        });
        const body = (await res.json()) as {
            ok: boolean;
            result?: unknown;
            message?: string;
        };
        if (!body.ok) throw new Error(body.message ?? `rpc failed: ${method}`);
        return body.result;
    };

    const live: LiveServer = {
        port,
        base,
        call,
        stop: () => ctx.stop(),
    };
    servers.push(live);
    return live;
};

class Client {
    private ws: WebSocket;
    private seq = 0;
    private pending = new Map<
        string,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    events: Envelope[] = [];

    private constructor(ws: WebSocket) {
        this.ws = ws;
        sockets.push(ws);
        ws.on("message", (raw) => {
            const frame = JSON.parse(String(raw)) as Envelope;
            if (frame.kind === "rpc:ok" || frame.kind === "rpc:err") {
                const entry = this.pending.get(frame.id);
                if (!entry) return;
                this.pending.delete(frame.id);
                if (frame.kind === "rpc:ok") entry.resolve(frame.result);
                else entry.reject(new Error(frame.message));
                return;
            }
            if (frame.kind === "event") this.events.push(frame);
        });
    }

    static async connect(base: string, token?: string): Promise<Client> {
        const url = token
            ? `${base.replace("http", "ws")}/ws?token=${encodeURIComponent(token)}`
            : `${base.replace("http", "ws")}/ws`;
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("ws connect timeout")),
                8000,
            );
            ws.on("open", () => {
                clearTimeout(timer);
                resolve();
            });
            ws.on("error", (err) => {
                clearTimeout(timer);
                reject(err as Error);
            });
        });
        return new Client(ws);
    }

    send(
        method: string,
        params: Record<string, unknown> = {},
    ): Promise<unknown> {
        const id = `c${++this.seq}`;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ kind: "rpc", id, method, params }));
            setTimeout(() => {
                if (!this.pending.delete(id))
                    reject(new Error(`rpc timeout: ${method}`));
            }, 8000);
        });
    }

    async waitForEvent(
        name: string,
        timeoutMs = 5000,
    ): Promise<Record<string, unknown>> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const hit = this.events.find((e) => e.name === name);
            if (hit) return hit.payload as Record<string, unknown>;
            if (Date.now() > deadline)
                throw new Error(`event timeout: ${name}`);
            await wait(50);
        }
    }

    async waitForMessage(timeoutMs = 5000): Promise<Record<string, unknown>> {
        const payload = await this.waitForEvent("message:new", timeoutMs);
        return payload.message as Record<string, unknown>;
    }

    close(): void {
        this.ws.close();
    }
}

const newDbFile = (): string =>
    join(mkdtempSync(join(tmpdir(), "plugim-e2e-")), "e2e.db");

describe("端到端冒烟", () => {
    it("注册 → 加好友 → 建群 → 收发消息 → 撤回 → 重启后数据仍在", async () => {
        const dbFile = newDbFile();
        const server = await startServer(dbFile);

        const alice = await Client.connect(server.base);
        const aliceAuth = (await alice.send("auth.register", {
            username: "alice",
            password: "Passw0rd!",
        })) as { token: string; user: { id: string; username: string } };
        alice.close();

        const bob = await Client.connect(server.base);
        const bobAuth = (await bob.send("auth.register", {
            username: "bob",
            password: "Passw0rd!",
        })) as { token: string; user: { id: string; username: string } };
        bob.close();

        const aliceWs = await Client.connect(server.base, aliceAuth.token);
        const bobWs = await Client.connect(server.base, bobAuth.token);
        expect(
            (await aliceWs.send("auth.me")) as { username: string },
        ).toMatchObject({ username: "alice" });

        const found = (await aliceWs.send("user.search", {
            keyword: "bob",
        })) as { users: { name: string }[] };
        expect(found.users.map((u) => u.name)).toContain("bob");

        await aliceWs.send("friend.request", {
            username: "bob",
            message: "我是 alice",
        });
        const incoming = (await bobWs.send("friend.list")) as {
            incoming: string[];
            incomingMessages: Record<string, string>;
        };
        expect(incoming.incoming).toContain("alice");
        expect(incoming.incomingMessages.alice).toBe("我是 alice");
        await bobWs.send("friend.accept", { username: "alice" });

        const friends = (await aliceWs.send("friend.list")) as {
            friends: string[];
        };
        expect(friends.friends).toContain("bob");

        const group = (await aliceWs.send("group.create", {
            name: "冒烟群",
            members: ["bob"],
        })) as { id: string };
        const session = `g:${group.id}`;

        const members = (await bobWs.send("group.members", {
            groupId: group.id,
        })) as { members: { username: string }[] };
        expect(members.members.map((m) => m.username).sort()).toEqual([
            "alice",
            "bob",
        ]);

        bobWs.events.length = 0;
        const sent = (await aliceWs.send("message.send", {
            session,
            content: "群里你好",
        })) as { id: string };
        const groupEvent = await bobWs.waitForMessage();
        expect(groupEvent.session).toBe(session);
        expect(groupEvent.content).toBe("群里你好");
        expect(groupEvent.id).toBe(sent.id);

        bobWs.events.length = 0;
        await aliceWs.send("message.send", {
            session: "p2p:bob",
            content: "私聊你好",
        });
        const p2pEvent = await bobWs.waitForMessage();
        expect(p2pEvent.content).toBe("私聊你好");
        expect(String(p2pEvent.session).startsWith("p2p:")).toBe(true);

        await aliceWs.send("message.recall", { id: sent.id });
        const history = (await aliceWs.send("history.list", {
            session,
            limit: 20,
        })) as { id: string; recalledAt?: string | null }[];
        const recalled = history.find((m) => m.id === sent.id);
        expect(recalled).toBeDefined();
        expect(recalled?.recalledAt).toBeTruthy();

        aliceWs.close();
        bobWs.close();
        await server.stop();
        servers.length = 0;

        const restarted = await startServer(dbFile);
        const relogin = (await restarted.call("auth.login", {
            username: "alice",
            password: "Passw0rd!",
        })) as { token: string };

        const afterRestart = (await restarted.call(
            "history.list",
            { session, limit: 20 },
            relogin.token,
        )) as { id: string }[];
        expect(afterRestart.map((m) => m.id)).toContain(sent.id);

        const groupList = (await restarted.call(
            "group.list",
            {},
            relogin.token,
        )) as { id: string }[];
        expect(groupList.map((g) => g.id)).toContain(group.id);
    }, 40_000);

    it("token 无效时拒绝业务调用", async () => {
        const server = await startServer(newDbFile());
        await expect(
            server.call("friend.list", {}, "not-a-real-token"),
        ).rejects.toThrow();
    }, 20_000);
});
