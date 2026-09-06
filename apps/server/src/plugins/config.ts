import type { Plugin } from "@plugim/core";

export interface AppConfig {
    port: number;
    dbDriver: "sqlite" | "postgres";
    dbUrl: string;
    dbFile: string;
    defaultSession: string;
}

export const configPlugin: Plugin = {
    name: "config",
    async apply(ctx) {
        const driver = process.env.PLUGIM_DB_DRIVER;
        ctx.provide<AppConfig>("config", {
            port: Number(process.env.PORT ?? 3000),
            dbDriver: driver === "postgres" ? "postgres" : "sqlite",
            dbUrl:
                process.env.DATABASE_URL ?? "postgres://localhost:5432/plugim",
            dbFile: process.env.PLUGIM_DB_FILE ?? "data/plugim.db",
            defaultSession: process.env.PLUGIM_DEFAULT_SESSION ?? "general",
        });
        return undefined;
    },
};
