import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autoDiscoverPlugins, Context } from "@plugim/core";
import { readInstallConfig } from "./installConfig";
import { installLifecycle } from "./lifecycle";
import { installFileLogger } from "./logger";
import { adminPlugin } from "./plugins/admin";
import { auditPlugin } from "./plugins/audit";
import { authPlugin } from "./plugins/auth";
import { backupPlugin } from "./plugins/backup";
import { chatPlugin } from "./plugins/chat";
import { configPlugin } from "./plugins/config";
import { containerPlugin } from "./plugins/container";
import { filesPlugin } from "./plugins/files";
import { friendsPlugin } from "./plugins/friends";
import { gatewayPlugin } from "./plugins/gateway";
import { groupPlugin } from "./plugins/group";
import { groupFilesPlugin } from "./plugins/group-files";
import { installPlugin } from "./plugins/install";
import { linkPreviewPlugin } from "./plugins/link-preview";
import { momentsPlugin } from "./plugins/moments";
import { orgPlugin } from "./plugins/org";
import { pushPlugin } from "./plugins/push";
import { screenPlugin } from "./plugins/screen";
import { stickersPlugin } from "./plugins/stickers";
import { storagePlugin } from "./plugins/storage";
import { tasksPlugin } from "./plugins/tasks";
import { updatePlugin } from "./plugins/update";
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

const envInt = (name: string): number | undefined => {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
};

const logDir =
    readInstallConfig().logDir || (process.env.PLUGIM_LOG_DIR ?? "").trim();
const logMaxMb = envInt("PLUGIM_LOG_MAX_MB");
const fileLogger = logDir
    ? installFileLogger({
          dir: logDir,
          maxBytes: logMaxMb ? logMaxMb * 1024 * 1024 : undefined,
          keepDays: envInt("PLUGIM_LOG_KEEP_DAYS"),
          keepFiles: envInt("PLUGIM_LOG_KEEP_FILES"),
      })
    : null;

const ctx = new Context();

const lifecycle = installLifecycle({
    log: ctx.log,
    timeoutMs: envInt("PLUGIM_SHUTDOWN_TIMEOUT_MS"),
    async stop() {
        await ctx.stop();
    },
    async dispose() {
        await fileLogger?.close();
    },
});

await autoDiscoverPlugins(ctx, [
    adminPlugin,
    auditPlugin,
    authPlugin,
    backupPlugin,
    chatPlugin,
    configPlugin,
    filesPlugin,
    friendsPlugin,
    gatewayPlugin,
    groupFilesPlugin,
    groupPlugin,
    installPlugin,
    linkPreviewPlugin,
    momentsPlugin,
    orgPlugin,
    pushPlugin,
    screenPlugin,
    storagePlugin,
    stickersPlugin,
    tasksPlugin,
    webPlugin,
    containerPlugin,
    updatePlugin,
]);

ctx.start().catch((err) => {
    ctx.log.error("failed to start:", err);
    void lifecycle.shutdown(1, "start failure");
});
