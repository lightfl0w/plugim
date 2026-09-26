import type { Plugin } from "@plugim/core";
import type { IceServerConfig } from "@plugim/protocol";
import { readInstallConfig } from "../installConfig";

export interface AppConfig {
    port: number;
    dbDriver: "sqlite" | "postgres";
    dbUrl: string;
    dbFile: string;
    logDir: string;
    defaultSession: string;
    jwtSecret: string;
    bootstrapAdmins: string[];
    allowRegister: boolean;
    inviteCode: string;
    vapidPublicKey: string;
    vapidPrivateKey: string;
    vapidSubject: string;
    iceServers: IceServerConfig[];
}

export const configPlugin: Plugin = {
    name: "config",
    description: "环境配置(端口 / DB / JWT)",
    provides: ["config"],
    async apply(ctx) {
        const driver = process.env.PLUGIM_DB_DRIVER;
        const jwtSecret = process.env.PLUGIM_JWT_SECRET;
        if (!jwtSecret) {
            ctx.log.warn(
                "PLUGIM_JWT_SECRET not set, using insecure dev secret",
            );
        }
        const install = readInstallConfig();
        ctx.provide<AppConfig>("config", {
            port: Number(process.env.PORT ?? 3000),
            dbDriver:
                install.dbDriver ??
                (driver === "postgres" ? "postgres" : "sqlite"),
            dbUrl:
                install.databaseUrl ??
                process.env.DATABASE_URL ??
                "postgres://localhost:5432/plugim",
            dbFile:
                install.dbFile ??
                process.env.PLUGIM_DB_FILE ??
                "data/plugim.db",
            logDir: install.logDir ?? process.env.PLUGIM_LOG_DIR ?? "",
            defaultSession: process.env.PLUGIM_DEFAULT_SESSION ?? "general",
            jwtSecret: jwtSecret ?? "plugim-dev-secret-do-not-use-in-prod",
            bootstrapAdmins: (process.env.PLUGIM_ADMINS ?? "")
                .split(",")
                .map((name) => name.trim().toLowerCase())
                .filter(Boolean),
            allowRegister: process.env.PLUGIM_ALLOW_REGISTER !== "false",
            inviteCode: process.env.PLUGIM_INVITE_CODE ?? "",
            vapidPublicKey: process.env.PLUGIM_VAPID_PUBLIC_KEY ?? "",
            vapidPrivateKey: process.env.PLUGIM_VAPID_PRIVATE_KEY ?? "",
            vapidSubject: process.env.PLUGIM_VAPID_SUBJECT ?? "",
            iceServers: [
                {
                    urls: (
                        process.env.PLUGIM_STUN_URLS ??
                        "stun:stun.l.google.com:19302"
                    )
                        .split(",")
                        .map((url) => url.trim())
                        .filter(Boolean),
                },
                ...(process.env.PLUGIM_TURN_URL
                    ? [
                          {
                              urls: process.env.PLUGIM_TURN_URL,
                              username:
                                  process.env.PLUGIM_TURN_USER ?? "plugim",
                              credential: process.env.PLUGIM_TURN_PASS ?? "",
                          },
                      ]
                    : []),
            ],
        });
        return undefined;
    },
};
