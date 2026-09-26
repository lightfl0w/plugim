import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Plugin } from "@plugim/core";
import type { GatewayService } from "../types";
import type { AppConfig } from "./config";

const here = dirname(fileURLToPath(import.meta.url));

const distCandidates = [
    (process.env.PLUGIM_WEB_DIST ?? "").trim(),
    resolve(here, "..", "web", "dist"),
    resolve(here, "..", "..", "web", "dist"),
    resolve(here, "..", "..", "..", "web", "dist"),
    resolve(process.cwd(), "..", "web", "dist"),
    resolve(process.cwd(), "apps", "web", "dist"),
].filter(Boolean);

const findWebDist = (): string | null => {
    for (const candidate of distCandidates) {
        if (existsSync(resolve(candidate, "index.html"))) return candidate;
    }
    return null;
};

export const webPlugin: Plugin = {
    name: "web",
    description: "生产模式单端口托管前端静态资源",
    inject: ["gateway", "config"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        const gateway = ctx.get<GatewayService>("gateway");
        const webDist = findWebDist();
        if (!webDist) {
            ctx.log.info("web dist not found, serving API only");
            return undefined;
        }

        let version = "0.0.0";
        try {
            const pkg = JSON.parse(
                readFileSync(resolve(here, "..", "package.json"), "utf8"),
            ) as { version?: string };
            version = pkg.version ?? version;
        } catch {}

        const app = gateway.hono();
        app.get("/version", (c) =>
            c.json({
                name: "plugim",
                version,
                node: process.versions.node,
                port: config.port,
            }),
        );
        app.use(
            "*",
            serveStatic({
                root: webDist,
                rewriteRequestPath: (path) =>
                    path.includes("..") ? "/__blocked__" : path,
            }),
        );
        app.notFound((c) => {
            const path = c.req.path;
            if (
                c.req.method !== "GET" ||
                path.startsWith("/rpc") ||
                path.startsWith("/ws") ||
                path.startsWith("/health") ||
                path.startsWith("/version")
            )
                return c.json({ ok: false, message: "not found" }, 404);
            try {
                return c.html(
                    readFileSync(resolve(webDist, "index.html"), "utf8"),
                );
            } catch {
                return c.json({ ok: false, message: "not found" }, 404);
            }
        });
        ctx.log.info(`web dist served from ${webDist}`);
        return undefined;
    },
};
