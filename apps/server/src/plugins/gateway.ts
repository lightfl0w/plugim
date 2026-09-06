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
import type { GatewayService, RpcHandler } from "../types";
import type { AppConfig } from "./config";

export const gatewayPlugin: Plugin = {
    name: "gateway",
    inject: ["config"],
    async apply(ctx): Promise<Dispose> {
        const config = ctx.get<AppConfig>("config");
        const handlers = new Map<string, RpcHandler>();
        const sockets = new Set<NodeWebSocket>();

        const app = new Hono();
        const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({
            app,
        });

        const rpc = (method: string, handler: RpcHandler) => {
            handlers.set(method, handler);
        };

        const broadcast = (name: string, payload: unknown) => {
            const frame: Envelope = {
                kind: "event",
                name: name as ServerEventName,
                payload,
            };
            const raw = JSON.stringify(frame);
            for (const ws of sockets) {
                if (ws.readyState === ws.OPEN) ws.send(raw);
            }
        };

        const dispatch = async (
            method: string,
            params: Record<string, unknown>,
        ) => {
            const handler = handlers.get(method);
            if (!handler) throw new Error(`unknown method: ${method}`);
            return handler(params);
        };

        app.post("/rpc/:method", async (c) => {
            const method = c.req.param("method");
            const body = await c.req.json().catch(() => ({}));
            const params =
                (body as { params?: Record<string, unknown> }).params ?? {};
            try {
                const result = await dispatch(method, params);
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
            upgradeWebSocket(() => ({
                onOpen(_evt, ws) {
                    sockets.add(ws.raw as NodeWebSocket);
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
                    const reply = (res: RpcOk | RpcErr) => {
                        if (ws.readyState === 1) ws.send(JSON.stringify(res));
                    };
                    dispatch(frame.method, frame.params).then(
                        (result) =>
                            reply({ kind: "rpc:ok", id: frame.id, result }),
                        (err) =>
                            reply({
                                kind: "rpc:err",
                                id: frame.id,
                                message: String(
                                    err instanceof Error ? err.message : err,
                                ),
                            }),
                    );
                },
                onClose(_evt, ws) {
                    sockets.delete(ws.raw as NodeWebSocket);
                },
            })),
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
            connections: () => sockets.size,
        });

        return async () => {
            for (const ws of sockets) ws.close();
            sockets.clear();
            server.close();
        };
    },
};
