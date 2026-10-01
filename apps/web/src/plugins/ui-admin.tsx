import type { Context } from "@plugim/core";
import { lazy } from "react";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { UiService } from "./ui-types";

export interface AdminService {
    is(): boolean;
    onChange(cb: () => void): () => void;
}

export const uiAdminSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const rpc = ctx.get<RpcService>("rpc");

    let isAdmin = false;
    const adminSubs = new Set<() => void>();
    const setAdmin = (next: boolean) => {
        if (isAdmin === next) return;
        isAdmin = next;
        for (const cb of adminSubs) cb();
    };
    const checkAdmin = () => {
        if (!auth.user()) {
            setAdmin(false);
            return;
        }
        void rpc
            .call("admin.stats", {})
            .then(() => setAdmin(true))
            .catch(() => setAdmin(false));
    };
    ctx.provide<AdminService>("admin", {
        is: () => isAdmin,
        onChange(cb) {
            adminSubs.add(cb);
            return () => {
                adminSubs.delete(cb);
            };
        },
    });
    const offUser = auth.onChange(checkAdmin);
    const offStatus = rpc.onStatus((status) => {
        if (status === "open") checkAdmin();
    });
    checkAdmin();

    const AdminPage = lazy(async () => {
        const module = await import("./ui-admin-page");
        return { default: module.createAdminPage(ctx) };
    });

    const unregisterRoute = ui.registerRoute("/admin", AdminPage);
    return () => {
        offUser();
        offStatus();
        unregisterRoute();
    };
};
