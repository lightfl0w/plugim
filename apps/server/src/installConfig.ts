import { spawn } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface InstallConfig {
    dbDriver?: "sqlite" | "postgres";
    dbFile?: string;
    databaseUrl?: string;
    logDir?: string;
}

const installFile = () =>
    process.env.PLUGIM_INSTALL_FILE || "data/install.json";

export const installConfigPath = (cwd = process.cwd()): string =>
    resolve(cwd, installFile());

export const readInstallConfig = (cwd = process.cwd()): InstallConfig => {
    try {
        const file = installConfigPath(cwd);
        if (!existsSync(file)) return {};
        const parsed = JSON.parse(readFileSync(file, "utf8")) as InstallConfig;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
};

export const writeInstallConfig = (
    config: InstallConfig,
    cwd = process.cwd(),
): void => {
    const file = installConfigPath(cwd);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 4));
    renameSync(tmp, file);
};

export const DB_FILE_RE = /^[\w./-]{1,256}\.db$/;
export const DB_URL_RE = /^postgres(?:ql)?:\/\/\S{1,512}$/;
export const LOG_DIR_RE = /^[\w./-]{0,256}$/;

export const respawnSelf = (): void => {
    const child = spawn(
        process.execPath,
        [...process.execArgv, ...process.argv.slice(1)],
        {
            cwd: process.cwd(),
            env: process.env,
            detached: true,
            stdio: "inherit",
        },
    );
    child.unref();
    process.exit(0);
};
