import type { Plugin } from "@plugim/core";
import type { Envelope } from "@plugim/protocol";

export type ConnStatus = "connecting" | "open" | "closed";

export interface RpcService {
    call(method: string, params: Record<string, unknown>): Promise<unknown>;
    status(): ConnStatus;
    onStatus(cb: (status: ConnStatus) => void): () => void;
}

export const connectionPlugin: Plugin = {
    name: "connection",
    async apply(ctx) {
        const pending = new Map<
            string,
            { resolve: (v: unknown) => void; reject: (e: Error) => void }
        >();
        const statusListeners = new Set<(status: ConnStatus) => void>();
        let seq = 0;
        let socket: WebSocket | undefined;
        let current: ConnStatus = "connecting";

        const setStatus = (next: ConnStatus) => {
            current = next;
            for (const cb of statusListeners) cb(next);
        };

        const connect = () => {
            const proto = location.protocol === "https:" ? "wss" : "ws";
            socket = new WebSocket(`${proto}://${location.host}/ws`);
            socket.onopen = () => setStatus("open");
            socket.onclose = () => {
                setStatus("closed");
                setTimeout(connect, 2000);
            };
            socket.onerror = () => socket?.close();
            socket.onmessage = (evt) => {
                let frame: Envelope;
                try {
                    frame = JSON.parse(evt.data) as Envelope;
                } catch {
                    return;
                }
                if (frame.kind === "event") {
                    ctx.emit(`server:${frame.name}`, frame.payload);
                } else if (frame.kind === "rpc:ok") {
                    pending.get(frame.id)?.resolve(frame.result);
                    pending.delete(frame.id);
                } else if (frame.kind === "rpc:err") {
                    pending.get(frame.id)?.reject(new Error(frame.message));
                    pending.delete(frame.id);
                }
            };
        };

        connect();

        ctx.provide<RpcService>("rpc", {
            call(method, params) {
                const ws = socket;
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    return Promise.reject(new Error("connection not open"));
                }
                return new Promise((resolve, reject) => {
                    const id = `r${++seq}`;
                    pending.set(id, { resolve, reject });
                    ws.send(
                        JSON.stringify({ kind: "rpc", id, method, params }),
                    );
                });
            },
            status: () => current,
            onStatus(cb) {
                statusListeners.add(cb);
                return () => statusListeners.delete(cb);
            },
        });
        return undefined;
    },
};
