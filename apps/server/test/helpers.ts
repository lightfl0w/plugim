import { Context } from "@plugim/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adminPlugin } from "../src/plugins/admin";
import { authPlugin } from "../src/plugins/auth";
import { chatPlugin } from "../src/plugins/chat";
import type { AppConfig } from "../src/plugins/config";
import { friendsPlugin } from "../src/plugins/friends";
import { groupPlugin } from "../src/plugins/group";
import { storagePlugin } from "../src/plugins/storage";
import type { AuthUser, RpcHandler } from "../src/types";

export interface RecordedEvent {
    name: string;
    userId?: string;
    payload: unknown;
}

export interface TestApp {
    ctx: Context;
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
    setOnline(user: AuthUser | null): void;
}

const PASSWORD = "Passw0rd!";

export const createTestApp = async (
    options: { admins?: string[] } = {},
): Promise<TestApp> => {
    const ctx = new Context();
    const handlers = new Map<string, RpcHandler>();
    const events: RecordedEvent[] = [];
    let authenticator:
        | ((token: string | null) => Promise<AuthUser | null>)
        | undefined;
    let onlineId: string | null = null;

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
        connections: () => 1,
        onlineUserIds: () => (onlineId ? [onlineId] : []),
        kickUser: (userId: string) => {
            if (onlineId === userId) onlineId = null;
        },
    });

    const dbFile = join(
        mkdtempSync(join(tmpdir(), "plugim-test-")),
        "test.db",
    );
    ctx.provide<AppConfig>("config", {
        port: 0,
        dbDriver: "sqlite",
        dbUrl: "",
        dbFile,
        defaultSession: "general",
        jwtSecret: "test-secret",
        bootstrapAdmins: options.admins ?? [],
    });

    ctx.plugin(storagePlugin);
    ctx.plugin(authPlugin);
    ctx.plugin(friendsPlugin);
    ctx.plugin(groupPlugin);
    ctx.plugin(chatPlugin);
    ctx.plugin(adminPlugin);
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
        call,
        events,
        eventsFor: (userId, name) =>
            events.filter(
                (event) =>
                    event.userId === userId &&
                    (name === undefined || event.name === name),
            ),
        register: async (username, password = PASSWORD) =>
            toAuthUser(
                await call("auth.register", { username, password }),
            ),
        login: async (username, password = PASSWORD) =>
            toAuthUser(await call("auth.login", { username, password })),
        verify: (token) =>
            authenticator
                ? authenticator(token)
                : Promise.reject(new Error("authenticator not set")),
        setOnline: (user) => {
            onlineId = user?.id ?? null;
        },
    };
};

export const asUser = (user: { id: string }): AuthUser => user as AuthUser;
