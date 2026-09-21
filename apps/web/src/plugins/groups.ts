import type { Plugin } from "@plugim/core";
import type { GroupInfo } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface GroupsService {
    cached(): GroupInfo[] | null;
    refresh(): Promise<GroupInfo[]>;
    onUpdate(cb: () => void): () => void;
}

export const groupsPlugin: Plugin = {
    name: "groups",
    description: "群组列表与更新订阅",
    provides: ["groups"],
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const listeners = new Set<() => void>();
        let cache: GroupInfo[] | null = null;
        let inflight: Promise<GroupInfo[]> | null = null;

        const emit = () => {
            for (const cb of listeners) cb();
        };

        const fetchList = () => {
            if (!inflight) {
                inflight = rpc
                    .call("group.list", {})
                    .then((result) => {
                        inflight = null;
                        cache = result as GroupInfo[];
                        emit();
                        return cache;
                    })
                    .catch((err) => {
                        inflight = null;
                        throw err;
                    });
            }
            return inflight;
        };

        const disposeUpdate = ctx.on("server:group:update", () => {
            void fetchList().catch(() => undefined);
        });
        if (rpc.status() === "open") void fetchList().catch(() => undefined);
        const unstatus = rpc.onStatus((status) => {
            if (status === "open") void fetchList().catch(() => undefined);
        });

        ctx.provide<GroupsService>("groups", {
            cached: () => cache,
            refresh: fetchList,
            onUpdate(cb) {
                listeners.add(cb);
                return () => listeners.delete(cb);
            },
        });
        return () => {
            disposeUpdate();
            unstatus();
        };
    },
};
