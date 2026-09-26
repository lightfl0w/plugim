import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Context } from "@plugim/core";
import { Hono } from "hono";
import { adminPlugin } from "../src/plugins/admin";
import { authPlugin } from "../src/plugins/auth";
import { chatPlugin } from "../src/plugins/chat";
import type { AppConfig } from "../src/plugins/config";
import { filesPlugin } from "../src/plugins/files";
import { friendsPlugin } from "../src/plugins/friends";
import { groupPlugin } from "../src/plugins/group";
import { groupFilesPlugin } from "../src/plugins/group-files";
import { installPlugin } from "../src/plugins/install";
import { pushPlugin } from "../src/plugins/push";
import { screenPlugin } from "../src/plugins/screen";
import { storagePlugin } from "../src/plugins/storage";
import { tasksPlugin } from "../src/plugins/tasks";
import type { AuthUser, RpcHandler } from "../src/types";

export interface RecordedEvent {
    name: string;
    userId?: string;
    payload: unknown;
}

export interface TestApp {
    ctx: Context;
    app: Hono;
    call(
        method: string,
        params?: Record<string, unknown>,
        user?: AuthUser | null,
    ): Promise<unknown>;
    events: RecordedEvent[];
    eventsFor(userId: string, name?: string): RecordedEvent[];
    register(
        username: string,
        password?: string,
    ): Promise<{ user: AuthUser; token: string }>;
    login(
        username: string,
        password?: string,
    ): Promise<{ user: AuthUser; token: string }>;
    verify(token: string | null): Promise<AuthUser | null>;
    setOnline(user: AuthUser | { id: string } | null): void;
    goOffline(userId: string): void;
}

const PASSWORD = "Passw0rd!";

export const createTestApp = async (
    options: {
        admins?: string[];
        allowRegister?: boolean;
        inviteCode?: string;
    } = {},
): Promise<TestApp> => {
    const ctx = new Context();
    const handlers = new Map<string, RpcHandler>();
    const events: RecordedEvent[] = [];
    const honoApp = new Hono();
    let authenticator:
        | ((token: string | null) => Promise<AuthUser | null>)
        | undefined;
    const onlineIds = new Set<string>();
    const offlineListeners = new Set<(userId: string) => void>();

    ctx.provide("gateway", {
        rpc: (method: string, handler: RpcHandler) => {
            handlers.set(method, handler);
        },
        broadcast: (name: string, payload: unknown) => {
            events.push({ name, payload });
        },
        emitToUser: (userId: string, name: string, payload: unknown) => {
            events.push({ name, userId, payload });
        },
        setAuthenticator: (
            verifier: (token: string | null) => Promise<AuthUser | null>,
        ) => {
            authenticator = verifier;
        },
        verify: (token: string | null) =>
            authenticator ? authenticator(token) : Promise.resolve(null),
        connections: () => 1,
        onlineUserIds: () => [...onlineIds],
        isUserOnline: (userId: string) => onlineIds.has(userId),
        kickUser: (userId: string) => {
            onlineIds.delete(userId);
            events.push({ name: "kick", userId });
        },
        onOffline: (cb: (userId: string) => void) => {
            offlineListeners.add(cb);
            return () => offlineListeners.delete(cb);
        },
        hono: () => honoApp,
    });

    const dbFile = join(mkdtempSync(join(tmpdir(), "plugim-test-")), "test.db");
    process.env.PLUGIM_INSTALL_FILE = join(dirname(dbFile), "install.json");
    ctx.provide<AppConfig>("config", {
        port: 0,
        dbDriver: "sqlite",
        dbUrl: "",
        dbFile,
        logDir: "",
        defaultSession: "general",
        jwtSecret: "test-secret",
        bootstrapAdmins: options.admins ?? [],
        allowRegister: options.allowRegister ?? true,
        inviteCode: options.inviteCode ?? "",
        vapidPublicKey: "",
        vapidPrivateKey: "",
        vapidSubject: "",
        iceServers: [{ urls: ["stun:stun.test:3478"] }],
        storageDriver: "local",
        storageDir: join(dirname(dbFile), "uploads"),
        uploadLimitMb: 20,
        s3Endpoint: "",
        s3Region: "",
        s3Bucket: "",
        s3AccessKey: "",
        s3SecretKey: "",
        s3PathStyle: "",
        s3PublicBase: "",
    });

    ctx.plugin(storagePlugin);
    ctx.plugin(tasksPlugin);
    ctx.plugin(authPlugin);
    ctx.plugin(installPlugin);
    ctx.plugin(friendsPlugin);
    ctx.plugin(groupPlugin);
    ctx.plugin(groupFilesPlugin);
    ctx.plugin(pushPlugin);
    ctx.plugin(chatPlugin);
    ctx.plugin(screenPlugin);
    ctx.plugin(adminPlugin);
    ctx.plugin(filesPlugin);
    await ctx.start();

    const call: TestApp["call"] = async (method, params = {}, user = null) => {
        const handler = handlers.get(method);
        if (!handler) throw new Error(`unknown method: ${method}`);
        return handler(params, { user });
    };

    const toAuthUser = (result: {
        token: string;
        user: { id: string; username: string };
    }) => ({
        user: { id: result.user.id, username: result.user.username },
        token: result.token,
    });

    return {
        ctx,
        app: honoApp,
        call,
        events,
        eventsFor: (userId, name) =>
            events.filter(
                (event) =>
                    event.userId === userId &&
                    (name === undefined || event.name === name),
            ),
        register: async (username, password = PASSWORD) =>
            toAuthUser(await call("auth.register", { username, password })),
        login: async (username, password = PASSWORD) =>
            toAuthUser(await call("auth.login", { username, password })),
        verify: (token) =>
            authenticator
                ? authenticator(token)
                : Promise.reject(new Error("authenticator not set")),
        setOnline: (user) => {
            if (user === null) onlineIds.clear();
            else onlineIds.add(user.id);
        },
        goOffline: (userId) => {
            if (!onlineIds.delete(userId)) return;
            for (const cb of offlineListeners) cb(userId);
        },
    };
};

export const asUser = (user: { id: string }): AuthUser => user as AuthUser;

export interface UploadResult {
    key: string;
    url: string;
    name: string;
    size: number;
    mime: string;
}

export const uploadFile = async (
    app: TestApp,
    token: string,
    name: string,
    mime: string,
    bytes: number,
): Promise<UploadResult> => {
    const res = await app.app.request("/upload", {
        method: "POST",
        headers: {
            authorization: `Bearer ${token}`,
            "content-type": mime,
            "x-file-name": encodeURIComponent(name),
        },
        body: new Uint8Array(bytes).fill(65),
    });
    const body = (await res.json()) as {
        ok: boolean;
        result?: UploadResult;
        message?: string;
    };
    if (!body.ok || !body.result)
        throw new Error(body.message ?? `upload failed: ${res.status}`);
    return body.result;
};
