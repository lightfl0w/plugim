import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Dispose, Plugin } from "@plugim/core";
import type {
    Envelope,
    PresenceStatus,
    RpcErr,
    RpcOk,
    ServerEventName,
} from "@plugim/protocol";
import { Hono } from "hono";
import { compress } from "hono/compress";
import type { WebSocket as NodeWebSocket } from "ws";
import type {
    AuthUser,
    ConnInfo,
    GatewayService,
    MetricsService,
    RpcHandler,
    SettingsStore,
    TokenVerifier,
} from "../types";
import type { AppConfig } from "./config";

const nullVerifier: TokenVerifier = () => Promise.resolve(null);

const MUST_CHANGE_ALLOWED = new Set([
    "auth.password",
    "auth.me",
    "presence.list",
    "presence.status",
    "presence.status.set",
]);

export const mustChangeBlocked = (
    user: AuthUser | null | undefined,
    method: string,
): boolean => Boolean(user?.mustChange) && !MUST_CHANGE_ALLOWED.has(method);

const toStatus = (raw: unknown): PresenceStatus =>
    raw === "busy" || raw === "away" || raw === "dnd" || raw === "invisible"
        ? raw
        : "online";

const clientIpOf = (req: unknown): string => {
    const raw = req as { socket?: { remoteAddress?: string } } | null;
    return String(raw?.socket?.remoteAddress ?? "").slice(0, 64);
};

const metricsOf = (ctx: { get<T>(name: string): T }): MetricsService | null => {
    try {
        return ctx.get<MetricsService>("metrics");
    } catch {
        return null;
    }
};

export const gatewayPlugin: Plugin = {
    name: "gateway",
    description: "WebSocket 网关与 RPC 注册表",
    provides: ["gateway"],
    inject: ["config", "settings"],
    async apply(ctx): Promise<Dispose> {
        const config = ctx.get<AppConfig>("config");
        const settings = ctx.get<SettingsStore>("settings");
        const handlers = new Map<string, RpcHandler>();
        const sockets = new Set<NodeWebSocket>();
        const identities = new Map<NodeWebSocket, AuthUser | null>();
        const liveness = new WeakMap<NodeWebSocket, boolean>();
        const lastSeen = new Map<string, string>();
        const offlineListeners = new Set<(userId: string) => void>();
        const connectListeners = new Set<(user: AuthUser) => void>();
        let verifyToken: TokenVerifier = nullVerifier;
        let metricsCache: MetricsService | null | undefined;

        const metrics = (): MetricsService | null => {
            if (metricsCache === undefined) metricsCache = metricsOf(ctx);
            return metricsCache;
        };

        const app = new Hono();
        app.use(compress());
        app.use("/ws", async (c, next) => {
            const origin = c.req.header("origin");
            if (origin) {
                let originHost = "";
                try {
                    originHost = new URL(origin).host;
                } catch {
                    originHost = "";
                }
                if (originHost !== c.req.header("host"))
                    return c.json({ ok: false, message: "拒绝跨站连接" }, 403);
            }
            await next();
        });
        const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
            app,
        });

        const announcePresence = async (user: AuthUser, online: boolean) => {
            if (online) {
                const status = toStatus(
                    await settings.get(`presence:${user.id}`),
                );
                if (status === "invisible") return;
                gatewayApi.broadcast("presence:update", {
                    username: user.username,
                    online,
                    status,
                });
                return;
            }
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
            if (name.startsWith("message:")) metrics()?.addMessage();
            for (const [ws, user] of identities) {
                if (user) sendFrame(ws, frame);
            }
        };

        const emitToUser = (userId: string, name: string, payload: unknown) => {
            const frame: Envelope = {
                kind: "event",
                name: name as ServerEventName,
                payload,
            };
            if (name.startsWith("message:")) metrics()?.addMessage();
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
            if (!handler) {
                metrics()?.observeRpc(method, 0, false);
                throw new Error(`未知方法: ${method}`);
            }
            if (mustChangeBlocked(conn.user, method)) {
                metrics()?.observeRpc(method, 0, false);
                throw new Error("请先修改初始密码后再使用");
            }
            const stats = metrics();
            if (!stats) return handler(params, conn);
            const startedAt = Date.now();
            try {
                const result = await handler(params, conn);
                stats.observeRpc(method, Date.now() - startedAt, true);
                return result;
            } catch (err) {
                stats.observeRpc(method, Date.now() - startedAt, false);
                throw err;
            }
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
                const result = await dispatch(method, params, {
                    user,
                    userAgent: c.req.header("user-agent") ?? "",
                    ip: clientIpOf(c.req.raw),
                });
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
                const userAgent = c.req.header("user-agent") ?? "";
                const ip = clientIpOf(c.req.raw);
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
                            if (!wasOnline) void announcePresence(user, true);
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
                        metrics()?.setConnections(sockets.size);
                        identities.set(raw, connUser);
                        liveness.set(raw, true);
                        raw.on("pong", () => liveness.set(raw, true));
                        if (connUser) {
                            lastSeen.set(connUser.id, connUser.username);
                            for (const cb of connectListeners) cb(connUser);
                            if (!wasOnline)
                                void announcePresence(connUser, true);
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
                            userAgent,
                            ip,
                        };
                        wsReply(raw, frame.id, () =>
                            dispatch(frame.method, frame.params, conn),
                        );
                    },
                    onClose(_evt, ws) {
                        const raw = ws.raw as NodeWebSocket;
                        const user = identities.get(raw) ?? null;
                        sockets.delete(raw);
                        metrics()?.setConnections(sockets.size);
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
            {
                fetch: (req, ...rest) => {
                    const stats = metrics();
                    const path =
                        req.url?.replace(/^https?:\/\/[^/]+/, "") ?? "";
                    if (!stats || path.startsWith("/metrics"))
                        return app.fetch(req, ...rest);
                    const startedAt = Date.now();
                    return Promise.resolve(app.fetch(req, ...rest)).then(
                        (response: Response) => {
                            stats.observeHttp(
                                Date.now() - startedAt,
                                response.status < 500,
                            );
                            return response;
                        },
                        (err: unknown) => {
                            stats.observeHttp(Date.now() - startedAt, false);
                            throw err;
                        },
                    );
                },
                port: config.port,
            },
            (info) => {
                ctx.log.info(
                    `gateway listening on http://localhost:${info.port}`,
                );
            },
        );
        injectWebSocket(server);

        const heartbeat = setInterval(() => {
            for (const ws of sockets) {
                if (liveness.get(ws) === false) {
                    ws.terminate();
                    continue;
                }
                liveness.set(ws, false);
                ws.ping();
            }
        }, 30000);

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

        const kickSession = (sessionId: string, keepSessionId?: string) => {
            for (const [ws, user] of identities) {
                if (user?.sessionId === sessionId) ws.close();
                else if (
                    keepSessionId !== undefined &&
                    user?.sessionId === keepSessionId
                )
                    continue;
            }
        };

        const gatewayApi: GatewayService = {
            rpc,
            broadcast,
            emitToUser,
            setAuthenticator: (verifier) => {
                verifyToken = verifier;
            },
            verify: (token) => verifyToken(token),
            connections: () => sockets.size,
            onlineUserIds,
            isUserOnline,
            kickUser,
            kickSession,
            onConnect: (cb) => {
                connectListeners.add(cb);
                return () => connectListeners.delete(cb);
            },
            onOffline: (cb) => {
                offlineListeners.add(cb);
                return () => offlineListeners.delete(cb);
            },
            hono: () => app,
        };

        ctx.provide<GatewayService>("gateway", gatewayApi);

        return async () => {
            clearInterval(heartbeat);
            for (const ws of sockets) ws.close();
            sockets.clear();
            identities.clear();
            server.close();
        };
    },
};
