import type { Context } from "@plugim/core";
import { lazy } from "react";
import { TOKEN_KEY } from "./auth";
import type { UiService } from "./ui-types";

export type AppMode = "chat" | "enterprise";

export interface InstallStatus {
    installed: boolean;
    hasUsers: boolean;
    mode: AppMode;
    dbDriver: string;
    dbFile: string;
    databaseUrlSet: boolean;
    logDir: string;
    allowRegister: boolean;
    inviteRequired: boolean;
}

export interface DbOptions {
    dbDriver: "sqlite" | "postgres";
    dbFile: string;
    databaseUrl: string;
    logDir: string;
}

export interface InstallService {
    status(): InstallStatus | null;
    loading(): boolean;
    reload(): Promise<InstallStatus | null>;
    testDb(opts: DbOptions): Promise<void>;
    saveDb(opts: DbOptions): Promise<void>;
    finish(opts: {
        allowRegister: boolean;
        inviteCode?: string;
        mode?: AppMode;
    }): Promise<void>;
    onChange(cb: () => void): () => void;
}

interface RpcResponse {
    ok: boolean;
    result?: unknown;
    message?: string;
}

const callInstallRpc = async (
    method: string,
    params: Record<string, unknown>,
): Promise<unknown> => {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(`/rpc/${method}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ params }),
    });
    const body = (await res.json()) as RpcResponse;
    if (!body.ok) throw new Error(body.message ?? "request failed");
    return body.result;
};

export const uiInstallSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");

    let status: InstallStatus | null = null;
    let loading = true;
    const subs = new Set<() => void>();
    const notify = () => {
        for (const cb of subs) cb();
    };

    const reload = async (): Promise<InstallStatus | null> => {
        try {
            status = (await callInstallRpc(
                "install.status",
                {},
            )) as InstallStatus;
        } catch {
            status = null;
        }
        loading = false;
        notify();
        return status;
    };
    void reload();

    const finish = async (opts: {
        allowRegister: boolean;
        inviteCode?: string;
        mode?: AppMode;
    }) => {
        await callInstallRpc("install.finish", {
            allowRegister: opts.allowRegister,
            ...(opts.inviteCode !== undefined
                ? { inviteCode: opts.inviteCode }
                : {}),
            ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        });
        await reload();
    };

    ctx.provide<InstallService>("install", {
        status: () => status,
        loading: () => loading,
        reload,
        async testDb(opts) {
            await callInstallRpc("install.testdb", { ...opts });
        },
        async saveDb(opts) {
            await callInstallRpc("install.savedb", { ...opts });
        },
        finish,
        onChange(cb) {
            subs.add(cb);
            return () => subs.delete(cb);
        },
    });

    const InstallPage = lazy(async () => {
        const module = await import("./ui-install-page");
        return { default: module.createInstallPage(ctx) };
    });

    const unregisterRoute = ui.registerRoute("/install", InstallPage);
    return () => {
        unregisterRoute();
    };
};
