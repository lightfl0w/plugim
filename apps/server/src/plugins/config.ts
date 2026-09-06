import type { Plugin } from "@plugim/core";

export interface AppConfig {
    port: number;
    dbDriver: "sqlite" | "postgres";
    dbUrl: string;
    dbFile: string;
    defaultSession: string;
    jwtSecret: string;
}

export const configPlugin: Plugin = {
    name: "config",
    async apply(ctx) {
        const driver = process.env.PLUGIM_DB_DRIVER;
        const jwtSecret = process.env.PLUGIM_JWT_SECRET;
        if (!jwtSecret) {
            ctx.log.warn(
                "PLUGIM_JWT_SECRET not set, using insecure dev secret",
            );
        }
        ctx.provide<AppConfig>("config", {
            port: Number(process.env.PORT ?? 3000),
            dbDriver: driver === "postgres" ? "postgres" : "sqlite",
            dbUrl:
                process.env.DATABASE_URL ?? "postgres://localhost:5432/plugim",
            dbFile: process.env.PLUGIM_DB_FILE ?? "data/plugim.db",
            defaultSession: process.env.PLUGIM_DEFAULT_SESSION ?? "general",
            jwtSecret: jwtSecret ?? "plugim-dev-secret-do-not-use-in-prod",
        });
        return undefined;
    },
};
