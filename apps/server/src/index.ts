import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@plugim/core";
import { readInstallConfig } from "./installConfig";
import { adminPlugin } from "./plugins/admin";
import { authPlugin } from "./plugins/auth";
import { chatPlugin } from "./plugins/chat";
import { configPlugin } from "./plugins/config";
import { friendsPlugin } from "./plugins/friends";
import { gatewayPlugin } from "./plugins/gateway";
import { groupPlugin } from "./plugins/group";
import { installPlugin } from "./plugins/install";
import { screenPlugin } from "./plugins/screen";
import { storagePlugin } from "./plugins/storage";
import { webPlugin } from "./plugins/web";

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
    console.error(
        `plugim requires Node >= 20, current ${process.versions.node}`,
    );
    process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(here, "..", ".env"),
    resolve(here, "..", "..", ".env"),
    resolve(here, "..", "..", "..", ".env"),
]) {
    if (existsSync(candidate)) {
        process.loadEnvFile(candidate);
        break;
    }
}

const logDir =
    readInstallConfig().logDir || (process.env.PLUGIM_LOG_DIR ?? "").trim();
if (logDir) {
    mkdirSync(resolve(process.cwd(), logDir), { recursive: true });
    const stream = createWriteStream(
        resolve(
            process.cwd(),
            logDir,
            `server-${new Date().toISOString().slice(0, 10)}.log`,
        ),
        { flags: "a" },
    );
    for (const level of ["log", "info", "warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
            original(...args);
            stream.write(
                `${new Date().toISOString()} [${level}] ${args.map(String).join(" ")}\n`,
            );
        };
    }
}

const ctx = new Context();
ctx.plugin(configPlugin);
ctx.plugin(gatewayPlugin);
ctx.plugin(storagePlugin);
ctx.plugin(authPlugin);
ctx.plugin(installPlugin);
ctx.plugin(friendsPlugin);
ctx.plugin(groupPlugin);
ctx.plugin(chatPlugin);
ctx.plugin(screenPlugin);
ctx.plugin(adminPlugin);
ctx.plugin(webPlugin);

ctx.start().catch((err) => {
    ctx.log.error("failed to start:", err);
    process.exit(1);
});

process.on("SIGINT", async () => {
    await ctx.stop();
    process.exit(0);
});
