import type { Plugin } from "@plugim/core";
import type { PresenceUpdate } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface PresenceService {
    isOnline(username: string): boolean;
    onChange(cb: () => void): () => void;
}

export const presencePlugin: Plugin = {
    name: "presence",
    description: "在线状态订阅",
    provides: ["presence"],
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const listeners = new Set<() => void>();
        let online = new Set<string>();

        const emit = () => {
            for (const cb of listeners) cb();
        };

        const load = () => {
            void rpc
                .call("presence.list", {})
                .then((result) => {
                    online = new Set(result as string[]);
                    emit();
                })
                .catch(() => undefined);
        };

        const dispose = ctx.on("server:presence:update", (payload) => {
            const { username, online: isOn } = payload as PresenceUpdate;
            const next = new Set(online);
            if (isOn) next.add(username);
            else next.delete(username);
            online = next;
            emit();
        });
        const unstatus = rpc.onStatus((status) => {
            if (status === "open") load();
        });
        if (rpc.status() === "open") load();

        ctx.provide<PresenceService>("presence", {
            isOnline: (username) => online.has(username),
            onChange(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });
        return () => {
            dispose();
            unstatus();
        };
    },
};
