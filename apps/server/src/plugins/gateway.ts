import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Dispose, Plugin } from "@plugim/core";
import type {
    Envelope,
    RpcErr,
    RpcOk,
    ServerEventName,
} from "@plugim/protocol";
import { Hono } from "hono";
import type { WebSocket as NodeWebSocket } from "ws";
import type {
    AuthUser,
    ConnInfo,
    GatewayService,
    RpcHandler,
    TokenVerifier,
} from "../types";
import type { AppConfig } from "./config";

const nullVerifier: TokenVerifier = () => Promise.resolve(null);

export const gatewayPlugin: Plugin = {
    name: "gateway",
    description: "WebSocket 网关与 RPC 注册表",
    provides: ["gateway"],
    inject: ["config"],
    async apply(ctx): Promise<Dispose> {
        const config = ctx.get<AppConfig>("config");
        const handlers = new Map<string, RpcHandler>();
        const sockets = new Set<NodeWebSocket>();
        const identities = new Map<NodeWebSocket, AuthUser | null>();
        const lastSeen = new Map<string, string>();
        const offlineListeners = new Set<(userId: string) => void>();
        let verifyToken: TokenVerifier = nullVerifier;

        const app = new Hono();
        const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
            app,
        });

        const announcePresence = (user: AuthUser, online: boolean) => {
            gatewayApi.broadcast("presence:update", {
                username: user.username,
                online,
            });
        };

        const refreshPresence = (userId: string) => {
            for (const user of identities.values()) {
                if (user?.id === userId) return;
            }
            const known = lastSeen.get(userId);
            if (known)
                gatewayApi.broadcast("presence:update", {
                    username: known,
                    online: false,
                });
        };

        const rpc = (method: string, handler: RpcHandler) => {
            handlers.set(method, handler);
        };

        const sendFrame = (ws: NodeWebSocket, frame: Envelope) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(frame));
        };

        const broadcast = (name: string, payload: unknown) => {
            const frame: Envelope = {
                kind: "event",
                name: name as ServerEventName,
                payload,
            };
            for (const ws of sockets) sendFrame(ws, frame);
        };

        const emitToUser = (userId: string, name: string, payload: unknown) => {
            const frame: Envelope = {
                kind: "event",
                name: name as ServerEventName,
                payload,
            };
            for (const [ws, user] of identities) {
                if (user?.id === userId) sendFrame(ws, frame);
            }
        };

        const dispatch = async (
            method: string,
            params: Record<string, unknown>,
            conn: ConnInfo,
        ) => {
            const handler = handlers.get(method);
            if (!handler) throw new Error(`未知方法: ${method}`);
            return handler(params, conn);
        };

        const wsReply = (
            ws: NodeWebSocket,
            id: string,
            run: () => Promise<unknown>,
        ) => {
            run().then(
                (result) =>
                    sendFrame(ws, { kind: "rpc:ok", id, result } as RpcOk),
                (err) =>
                    sendFrame(ws, {
                        kind: "rpc:err",
                        id,
                        message: String(
                            err instanceof Error ? err.message : err,
                        ),
                    } as RpcErr),
            );
        };

        app.post("/rpc/:method", async (c) => {
            const method = c.req.param("method");
            const body = await c.req.json().catch(() => ({}));
            const params =
                (body as { params?: Record<string, unknown> }).params ?? {};
            const header = c.req.header("authorization");
            const token = header?.startsWith("Bearer ")
                ? header.slice(7)
                : null;
            const user = await verifyToken(token);
            try {
                const result = await dispatch(method, params, { user });
                return c.json({ ok: true, result });
            } catch (err) {
                return c.json(
                    {
                        ok: false,
                        message: String(
                            err instanceof Error ? err.message : err,
                        ),
                    },
                    400,
                );
            }
        });

        app.get(
            "/ws",
            upgradeWebSocket((c) => {
                const token =
                    new URL(c.req.url).searchParams.get("token") ?? null;
                let connRaw: NodeWebSocket | undefined;
                let connUser: AuthUser | null = null;
                verifyToken(token)
                    .then((user) => {
                        connUser = user;
                        if (!connRaw) return;
                        const wasOnline = user
                            ? onlineUserIds().includes(user.id)
                            : false;
                        identities.set(connRaw, user);
                        if (user) {
                            lastSeen.set(user.id, user.username);
                            if (!wasOnline) announcePresence(user, true);
                        }
                    })
                    .catch(() => undefined);
                return {
                    onOpen(_evt, ws) {
                        const raw = ws.raw as NodeWebSocket;
                        connRaw = raw;
                        const wasOnline = connUser
                            ? onlineUserIds().includes(connUser.id)
                            : false;
                        sockets.add(raw);
                        identities.set(raw, connUser);
                        if (connUser) {
                            lastSeen.set(connUser.id, connUser.username);
                            if (!wasOnline) announcePresence(connUser, true);
                        }
                    },
                    onMessage(evt, ws) {
                        if (typeof evt.data !== "string") return;
                        let frame: Envelope;
                        try {
                            frame = JSON.parse(evt.data) as Envelope;
                        } catch {
                            return;
                        }
                        if (frame.kind !== "rpc") return;
                        const raw = ws.raw as NodeWebSocket;
                        const conn: ConnInfo = {
                            user: identities.get(raw) ?? null,
                        };
                        wsReply(raw, frame.id, () =>
                            dispatch(frame.method, frame.params, conn),
                        );
                    },
                    onClose(_evt, ws) {
                        const raw = ws.raw as NodeWebSocket;
                        const user = identities.get(raw) ?? null;
                        sockets.delete(raw);
                        identities.delete(raw);
                        if (user) refreshPresence(user.id);
                        if (user && !isUserOnline(user.id))
                            for (const cb of offlineListeners) cb(user.id);
                    },
                };
            }),
        );

        app.get("/health", (c) =>
            c.json({ ok: true, connections: sockets.size }),
        );

        const server = serve(
            { fetch: app.fetch, port: config.port },
            (info) => {
                ctx.log.info(
                    `gateway listening on http://localhost:${info.port}`,
                );
            },
        );
        injectWebSocket(server);

        const onlineUserIds = (): string[] => [
            ...new Set(
                [...identities.values()]
                    .filter((user): user is AuthUser => user !== null)
                    .map((user) => user.id),
            ),
        ];

        const isUserOnline = (userId: string): boolean => {
            for (const user of identities.values()) {
                if (user?.id === userId) return true;
            }
            return false;
        };

        const kickUser = (userId: string) => {
            for (const [ws, user] of identities) {
                if (user?.id === userId) ws.close();
            }
        };

        const gatewayApi: GatewayService = {
            rpc,
            broadcast,
            emitToUser,
            setAuthenticator: (verifier) => {
                verifyToken = verifier;
            },
            connections: () => sockets.size,
            onlineUserIds,
            isUserOnline,
            kickUser,
            onOffline: (cb) => {
                offlineListeners.add(cb);
                return () => offlineListeners.delete(cb);
            },
            hono: () => app,
        };

        ctx.provide<GatewayService>("gateway", gatewayApi);

        return async () => {
            for (const ws of sockets) ws.close();
            sockets.clear();
            identities.clear();
            server.close();
        };
    },
};
