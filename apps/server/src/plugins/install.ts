import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin } from "@plugim/core";
import Database from "better-sqlite3";
import postgres from "postgres";
import {
    DB_FILE_RE,
    DB_URL_RE,
    LOG_DIR_RE,
    readInstallConfig,
    respawnSelf,
    writeInstallConfig,
} from "../installConfig";
import type { AccountsStore, GatewayService, SettingsStore } from "../types";
import type { AppConfig } from "./config";

interface InstallFinishParams {
    allowRegister?: unknown;
    inviteCode?: unknown;
}

interface InstallDbParams {
    dbDriver?: unknown;
    dbFile?: unknown;
    databaseUrl?: unknown;
    logDir?: unknown;
}

const testDatabase = async (
    driver: "sqlite" | "postgres",
    file: string,
    url: string,
): Promise<void> => {
    if (driver === "sqlite") {
        const path = resolve(process.cwd(), file);
        mkdirSync(dirname(path), { recursive: true });
        const db = new Database(path);
        db.pragma("user_version");
        db.close();
        return;
    }
    const client = postgres(url, { max: 1, connect_timeout: 5 });
    try {
        await client.unsafe("select 1");
    } finally {
        await client.end({ timeout: 2 });
    }
};

const normalizeDbParams = (
    raw: InstallDbParams,
): {
    driver: "sqlite" | "postgres";
    file: string;
    url: string;
    logDir: string;
} => {
    const driver: "sqlite" | "postgres" =
        raw.dbDriver === "postgres" ? "postgres" : "sqlite";
    const file = String(raw.dbFile ?? "").trim();
    const url = String(raw.databaseUrl ?? "").trim();
    const logDir = String(raw.logDir ?? "").trim();
    if (!LOG_DIR_RE.test(logDir))
        throw new Error("日志目录仅允许字母数字与 . / _ -");
    if (driver === "sqlite") {
        const target = file || "data/plugim.db";
        if (!DB_FILE_RE.test(target))
            throw new Error("数据库文件名需以 .db 结尾，且不含空格");
        return { driver, file: target, url: "", logDir };
    }
    if (!DB_URL_RE.test(url))
        throw new Error("Postgres 连接串需以 postgres:// 开头");
    return { driver, file: "", url, logDir };
};

export const installPlugin: Plugin = {
    name: "install",
    description: "安装向导(数据库/日志初始化与上锁)",
    provides: ["install-rpc"],
    inject: ["gateway", "accounts", "settings", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const settings = ctx.get<SettingsStore>("settings");
        const config = ctx.get<AppConfig>("config");

        const isLocked = async () =>
            (await settings.get("installed")) === "true";

        gateway.rpc("install.status", async () => {
            const allow = await settings.get("allow_register");
            const invite = await settings.get("invite_code");
            const hasUsers = (await accounts.count()) > 0;
            const install = readInstallConfig();
            return {
                installed: hasUsers || (await isLocked()),
                hasUsers,
                dbDriver: config.dbDriver,
                dbFile:
                    install.dbFile ??
                    (config.dbDriver === "sqlite" ? config.dbFile : ""),
                databaseUrlSet:
                    install.databaseUrl !== undefined ||
                    !!process.env.DATABASE_URL,
                logDir: install.logDir ?? config.logDir,
                allowRegister:
                    allow === null ? config.allowRegister : allow !== "false",
                inviteRequired:
                    (invite === null ? config.inviteCode : invite.trim()) !==
                    "",
            };
        });

        gateway.rpc("install.testdb", async (raw) => {
            if (await isLocked()) throw new Error("系统已完成初始化");
            const params = normalizeDbParams(raw as unknown as InstallDbParams);
            try {
                await testDatabase(params.driver, params.file, params.url);
            } catch (err) {
                throw new Error(`连接失败: ${String(err).slice(0, 200)}`);
            }
            return true;
        });

        gateway.rpc("install.savedb", async (raw) => {
            if (await isLocked()) throw new Error("系统已完成初始化");
            const params = normalizeDbParams(raw as unknown as InstallDbParams);
            await testDatabase(params.driver, params.file, params.url);
            if (params.logDir)
                mkdirSync(resolve(process.cwd(), params.logDir), {
                    recursive: true,
                });
            writeInstallConfig({
                ...readInstallConfig(),
                dbDriver: params.driver,
                dbFile: params.driver === "sqlite" ? params.file : undefined,
                databaseUrl:
                    params.driver === "postgres" ? params.url : undefined,
                logDir: params.logDir,
            });
            if (!process.env.VITEST) setTimeout(() => respawnSelf(), 400);
            return true;
        });

        gateway.rpc("install.finish", async (raw) => {
            if (await isLocked()) throw new Error("系统已完成初始化");
            const { allowRegister, inviteCode } =
                raw as unknown as InstallFinishParams;
            if (typeof allowRegister === "boolean")
                await settings.set(
                    "allow_register",
                    allowRegister ? "true" : "false",
                );
            if (typeof inviteCode === "string")
                await settings.set(
                    "invite_code",
                    inviteCode.trim().slice(0, 64),
                );
            await settings.set("installed", "true");
            return true;
        });
        return undefined;
    },
};
