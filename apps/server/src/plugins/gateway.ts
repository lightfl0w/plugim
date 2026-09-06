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
    inject: ["config"],
    async apply(ctx): Promise<Dispose> {
        const config = ctx.get<AppConfig>("config");
        const handlers = new Map<string, RpcHandler>();
        const sockets = new Set<NodeWebSocket>();
        const identities = new Map<NodeWebSocket, AuthUser | null>();
        let verifyToken: TokenVerifier = nullVerifier;

        const app = new Hono();
        const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
            app,
        });

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
            if (!handler) throw new Error(`unknown method: ${method}`);
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
                        if (connRaw) identities.set(connRaw, user);
                    })
                    .catch(() => undefined);
                return {
                    onOpen(_evt, ws) {
                        const raw = ws.raw as NodeWebSocket;
                        connRaw = raw;
                        sockets.add(raw);
                        identities.set(raw, connUser);
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
                        sockets.delete(raw);
                        identities.delete(raw);
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

        ctx.provide<GatewayService>("gateway", {
            rpc,
            broadcast,
            emitToUser,
            setAuthenticator: (verifier) => {
                verifyToken = verifier;
            },
            connections: () => sockets.size,
        });

        return async () => {
            for (const ws of sockets) ws.close();
            sockets.clear();
            identities.clear();
            server.close();
        };
    },
};
