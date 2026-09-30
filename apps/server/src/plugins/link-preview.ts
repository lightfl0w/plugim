import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import type { Plugin } from "@plugim/core";
import type { LinkPreview } from "@plugim/protocol";
import type { LinkPreviewService } from "../types";
import type { AppConfig } from "./config";

const URL_MAX = 500;
const TEXT_MAX = 200;
const DESC_MAX = 300;
const TIMEOUT_MS = 5000;
const BYTES_MAX = 512 * 1024;
const REDIRECT_MAX = 3;
const CACHE_TTL_MS = 600_000;
const CACHE_MAX = 200;
const USER_AGENT = "Mozilla/5.0 (compatible; plugim/1.0; +link-preview)";

const decodeHtml = (raw: string): string => {
    const named: Record<string, string> = {
        amp: "&",
        apos: "'",
        gt: ">",
        lt: "<",
        nbsp: " ",
        quot: '"',
    };
    return raw.replace(
        /&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi,
        (match, code: string) => {
            const lower = code.toLowerCase();
            if (lower.startsWith("#")) {
                const hex = lower.startsWith("#x");
                const value = Number.parseInt(
                    lower.slice(hex ? 2 : 1),
                    hex ? 16 : 10,
                );
                if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff)
                    return match;
                return String.fromCodePoint(value);
            }
            return named[lower] ?? match;
        },
    );
};

const metaContent = (html: string): Map<string, string> => {
    const map = new Map<string, string>();
    for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
        let key = "";
        let content: string | null = null;
        for (const attr of tag.matchAll(
            /([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
        )) {
            const name = attr[1].toLowerCase();
            const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
            if (name === "property" || name === "name")
                key = value.toLowerCase();
            else if (name === "content") content = value;
        }
        if (key && content !== null && !map.has(key))
            map.set(key, decodeHtml(content).trim());
    }
    return map;
};

const isPrivateV4 = (host: string): boolean => {
    const parts = host.split(".").map((part) => Number(part));
    if (parts.length !== 4) return false;
    if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return false;
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
    );
};

const isPrivateV6 = (host: string): boolean => {
    if (host === "::" || host === "::1") return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateV4(mapped[1]);
    const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const high = Number.parseInt(mappedHex[1], 16);
        const low = Number.parseInt(mappedHex[2], 16);
        return isPrivateV4(
            `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
        );
    }
    const head = host.split(":")[0] ?? "";
    return (
        /^fe[89ab]/.test(head) ||
        head.startsWith("fc") ||
        head.startsWith("fd") ||
        head.startsWith("ff")
    );
};

const isPrivateHost = (hostname: string): boolean => {
    const host = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
    if (!host) return true;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.endsWith(".home.arpa")
    )
        return true;
    if (host.includes(":")) return isPrivateV6(host);
    if (isPrivateV4(host)) return true;
    return !host.includes(".");
};

const inList = (hostname: string, list: string[]): boolean =>
    list.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));

interface FetchedResponse {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    body: ReadableStream<Uint8Array> | null;
}

const pinnedFetch = (target: URL, ip: string): Promise<FetchedResponse> =>
    new Promise((resolvePromise, rejectPromise) => {
        const isHttps = target.protocol === "https:";
        const transport = isHttps ? https : http;
        const family = net.isIP(ip);
        if (!family) {
            rejectPromise(new Error("无法解析该域名"));
            return;
        }
        const req = transport.request(
            target,
            {
                lookup: (_host, _options, callback) => {
                    callback(null, ip, family);
                },
                servername: isHttps ? target.hostname : undefined,
                headers: {
                    accept: "text/html,application/xhtml+xml",
                    "user-agent": USER_AGENT,
                },
            },
            (res) => {
                const status = res.statusCode ?? 0;
                const headers = res.headers;
                resolvePromise({
                    ok: status >= 200 && status < 300,
                    status,
                    headers: {
                        get: (name: string) => {
                            const value = headers[name.toLowerCase()];
                            if (value === undefined) return null;
                            return Array.isArray(value)
                                ? value.join(", ")
                                : value;
                        },
                    },
                    body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
                });
            },
        );
        req.setTimeout(TIMEOUT_MS, () => {
            req.destroy(new Error("链接无法访问"));
        });
        req.on("error", (err) => rejectPromise(err));
        req.end();
    });

export const linkTransport: {
    fetch: (target: URL, ip: string) => Promise<FetchedResponse>;
} = { fetch: pinnedFetch };

const readHtml = async (response: FetchedResponse): Promise<string> => {
    const body = response.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            size += value.byteLength;
            if (size > BYTES_MAX) break;
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => undefined);
    }
    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
};

const resolveImage = (value: string, base: string): string | null => {
    if (!value) return null;
    try {
        const url = new URL(value, base);
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
        return url.href;
    } catch {
        return null;
    }
};

const URL_IN_TEXT = /https?:\/\/[^\s<>"']{5,}/i;

const firstUrlIn = (text: string): string | null => {
    const match = URL_IN_TEXT.exec(text);
    if (!match) return null;
    const url = match[0].replace(/[),.;!?，。；！？、）】]+$/, "");
    return url.length > 9 ? url : null;
};

export const linkPreviewPlugin: Plugin = {
    name: "link-preview",
    description: "抓取网页标题、摘要与封面生成链接卡片",
    provides: ["link-preview"],
    inject: ["config"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        const allow = config.linkAllowHosts;
        const deny = config.linkDenyHosts;
        const cache = new Map<string, { at: number; value: LinkPreview }>();

        const guard = async (
            value: string,
        ): Promise<{ url: URL; ip: string }> => {
            let url: URL;
            try {
                url = new URL(value);
            } catch {
                throw new Error("链接地址无效");
            }
            if (url.protocol !== "http:" && url.protocol !== "https:")
                throw new Error("仅支持 http/https 链接");
            if (
                url.port &&
                url.port !== (url.protocol === "https:" ? "443" : "80")
            )
                throw new Error("仅支持 80/443 端口");
            if (url.username || url.password)
                throw new Error("链接不能包含账号密码");
            const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
            if (!hostname) throw new Error("链接地址无效");
            if (deny.length > 0 && inList(hostname, deny))
                throw new Error("该域名已被禁止访问");
            if (allow.length > 0 && !inList(hostname, allow))
                throw new Error("该域名不在允许的抓取范围内");
            if (isPrivateHost(hostname)) throw new Error("不支持访问内网地址");
            let records: { address: string }[];
            try {
                records = await dns.lookup(hostname, {
                    all: true,
                    verbatim: true,
                });
            } catch {
                throw new Error("无法解析该域名");
            }
            if (records.length === 0) throw new Error("无法解析该域名");
            if (records.some((record) => isPrivateHost(record.address)))
                throw new Error("不支持访问内网地址");
            return { url, ip: records[0].address };
        };

        const read = async (rawUrl: unknown): Promise<LinkPreview> => {
            const candidate = typeof rawUrl === "string" ? rawUrl.trim() : "";
            if (!candidate) throw new Error("请输入链接地址");
            if (candidate.length > URL_MAX)
                throw new Error(`链接不能超过 ${URL_MAX} 个字符`);
            const requested = candidate.includes("://")
                ? candidate
                : `https://${candidate}`;
            const hit = cache.get(requested);
            if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
            let current = requested;
            let response: FetchedResponse | null = null;
            for (let hop = 0; hop <= REDIRECT_MAX; hop += 1) {
                const { url: target, ip } = await guard(current);
                try {
                    response = await linkTransport.fetch(target, ip);
                } catch {
                    throw new Error("链接无法访问");
                }
                if (response.status < 300 || response.status >= 400) break;
                const location = response.headers.get("location");
                void response.body?.cancel().catch(() => undefined);
                if (!location) throw new Error("链接无法访问");
                if (hop === REDIRECT_MAX) throw new Error("链接重定向次数过多");
                current = new URL(location, target).href;
            }
            if (!response) throw new Error("链接无法访问");
            if (!response.ok) {
                void response.body?.cancel().catch(() => undefined);
                throw new Error(`链接无法访问（${response.status}）`);
            }
            const type = (
                response.headers.get("content-type") ?? ""
            ).toLowerCase();
            if (!type.includes("text/html")) throw new Error("链接不是网页");
            let html: string;
            try {
                html = await readHtml(response);
            } catch {
                throw new Error("链接读取失败");
            }
            const meta = metaContent(html);
            const host = new URL(current).hostname.replace(/^www\./i, "");
            const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
            const title = (
                meta.get("og:title") ||
                meta.get("twitter:title") ||
                (titleTag ? decodeHtml(titleTag[1]).trim() : "")
            ).slice(0, TEXT_MAX);
            const description = (
                meta.get("og:description") ||
                meta.get("description") ||
                meta.get("twitter:description") ||
                ""
            ).slice(0, DESC_MAX);
            const value: LinkPreview = {
                url: current,
                title: title || host,
                description,
                image: resolveImage(
                    meta.get("og:image") ||
                        meta.get("og:image:url") ||
                        meta.get("twitter:image") ||
                        "",
                    current,
                ),
                site:
                    (meta.get("og:site_name") || "").slice(0, TEXT_MAX) || host,
            };
            if (cache.size >= CACHE_MAX)
                cache.delete(cache.keys().next().value as string);
            cache.set(requested, { at: Date.now(), value });
            return value;
        };

        ctx.provide<LinkPreviewService>("link-preview", {
            preview: read,
            async previewOfText(content) {
                const url = firstUrlIn(content);
                return url ? read(url) : null;
            },
            clear: () => cache.clear(),
        });
        return undefined;
    },
};
