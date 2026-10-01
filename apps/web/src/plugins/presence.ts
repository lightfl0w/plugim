import type { Plugin } from "@plugim/core";
import type {
    PresenceListResult,
    PresenceStatus,
    PresenceUpdate,
} from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface PresenceService {
    isOnline(username: string): boolean;
    statusOf(username: string): PresenceStatus | null;
    myStatus(): PresenceStatus;
    setMyStatus(status: PresenceStatus): Promise<void>;
    onChange(cb: () => void): () => void;
}

export const presencePlugin: Plugin = {
    name: "presence",
    description: "在线状态订阅",
    provides: ["presence"],
    inject: ["rpc", "auth"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const auth = ctx.get<{ user: () => { username: string } | null }>(
            "auth",
        );
        const listeners = new Set<() => void>();
        let online = new Set<string>();
        let statuses: Record<string, PresenceStatus> = {};
        let mine: PresenceStatus = "online";

        const emit = () => {
            for (const cb of listeners) cb();
        };

        const load = () => {
            void rpc
                .call("presence.list", {})
                .then((result) => {
                    const data = result as PresenceListResult;
                    if (Array.isArray(data?.online))
                        online = new Set(data.online);
                    statuses = data?.statuses ?? {};
                    emit();
                })
                .catch(() => undefined);
            void rpc
                .call("presence.status", {})
                .then((result) => {
                    const data = result as { status?: PresenceStatus };
                    if (data?.status) {
                        mine = data.status;
                        emit();
                    }
                })
                .catch(() => undefined);
        };

        const dispose = ctx.on("server:presence:update", (payload) => {
            const {
                username,
                online: isOn,
                status,
            } = payload as PresenceUpdate;
            const next = new Set(online);
            if (isOn) next.add(username);
            else next.delete(username);
            online = next;
            const nextStatuses = { ...statuses };
            if (isOn && status) nextStatuses[username] = status;
            else if (!isOn) delete nextStatuses[username];
            statuses = nextStatuses;
            if (username === auth.user()?.username && status) {
                mine = status;
            }
            emit();
        });
        const unstatus = rpc.onStatus((status) => {
            if (status === "open") load();
        });
        if (rpc.status() === "open") load();

        ctx.provide<PresenceService>("presence", {
            isOnline: (username) => online.has(username),
            statusOf: (username) => statuses[username] ?? null,
            myStatus: () => mine,
            async setMyStatus(status) {
                const result = (await rpc.call("presence.status.set", {
                    status,
                })) as { status?: PresenceStatus };
                mine = result.status ?? status;
                if (status === "invisible") {
                    const next = new Set(online);
                    next.delete(auth.user()?.username ?? "");
                    online = next;
                    const nextStatuses = { ...statuses };
                    delete nextStatuses[auth.user()?.username ?? ""];
                    statuses = nextStatuses;
                } else {
                    statuses = {
                        ...statuses,
                        [auth.user()?.username ?? ""]: status,
                    };
                }
                emit();
            },
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
