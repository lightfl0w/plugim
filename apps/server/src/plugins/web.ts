import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Plugin } from "@plugim/core";
import type { GatewayService, SettingsStore } from "../types";
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
    inject: ["gateway", "config", "settings"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        const gateway = ctx.get<GatewayService>("gateway");
        const settings = ctx.get<SettingsStore>("settings");
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

        let buildId = "";
        for (const candidate of [
            process.env.PLUGIM_REPO,
            resolve(here, "..", "..", ".."),
            resolve(here, "..", ".."),
            process.cwd(),
        ]) {
            if (!candidate) continue;
            if (!existsSync(resolve(candidate, ".git"))) continue;
            try {
                buildId = execFileSync(
                    "git",
                    ["rev-parse", "--short", "HEAD"],
                    {
                        cwd: candidate,
                        encoding: "utf8",
                        stdio: ["ignore", "pipe", "ignore"],
                        timeout: 5000,
                    },
                ).trim();
            } catch (err) {
                ctx.log.warn(
                    `git rev-parse failed in ${candidate}: ${String(err)}`,
                );
            }
            if (buildId) break;
        }

        const app = gateway.hono();

        const renderIndex = async (): Promise<string> => {
            const [name, icon] = await Promise.all([
                settings.get("site_name"),
                settings.get("site_icon"),
            ]);
            const siteName = name?.trim() || "plugim";
            let html = readFileSync(resolve(webDist, "index.html"), "utf8");
            html = html.replace(
                /<title[^>]*>[\s\S]*?<\/title>/i,
                `<title>${siteName}</title>`,
            );
            html = html.replace(/content="plugim"/g, `content="${siteName}"`);
            if (siteName !== "plugim" && html.includes("<title>plugim</title>"))
                ctx.log.warn(
                    `index.html title replace missed (dist=${webDist})`,
                );
            const iconHref = icon?.trim();
            if (iconHref) {
                html = html.replaceAll(
                    'href="/icons/icon-192.png"',
                    `href="${iconHref}"`,
                );
                html = html.replaceAll(
                    'href="/icons/apple-touch-icon.png"',
                    `href="${iconHref}"`,
                );
            }
            return html;
        };

        app.get("/", (c) =>
            renderIndex()
                .then((html) => {
                    c.header("Cache-Control", "no-cache");
                    return c.html(html);
                })
                .catch(() => c.text("server error", 500)),
        );

        app.get("/site/meta", async (c) => {
            const [name, icon] = await Promise.all([
                settings.get("site_name"),
                settings.get("site_icon"),
            ]);
            return c.json({
                name: name?.trim() || "plugim",
                icon: icon?.trim() || "",
            });
        });
        app.get("/version", (c) =>
            c.json({
                name: "plugim",
                version,
                buildId,
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
                onFound: (_path, c) => {
                    const p = c.req.path;
                    if (p.startsWith("/assets/"))
                        c.header(
                            "Cache-Control",
                            "public, max-age=31536000, immutable",
                        );
                    else if (
                        p === "/" ||
                        p.endsWith("/index.html") ||
                        p === "/sw.js" ||
                        p === "/manifest.webmanifest"
                    )
                        c.header("Cache-Control", "no-cache");
                    else c.header("Cache-Control", "public, max-age=3600");
                },
            }),
        );
        app.notFound(async (c) => {
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
                c.header("Cache-Control", "no-cache");
                return c.html(await renderIndex());
            } catch {
                return c.json({ ok: false, message: "not found" }, 404);
            }
        });
        ctx.log.info(`web dist served from ${webDist}`);
        return undefined;
    },
};
