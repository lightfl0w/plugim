import { promises as dns } from "node:dns";
import { Context } from "@plugim/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/plugins/config";
import { linkPreviewPlugin } from "../src/plugins/link-preview";
import type { LinkPreviewService } from "../src/types";

vi.mock("node:dns", () => ({ promises: { lookup: vi.fn() } }));

const lookup = vi.mocked(dns.lookup);

const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

const silent = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

const make = async (config: Partial<AppConfig> = {}) => {
    const ctx = new Context({ log: silent });
    ctx.provide<AppConfig>("config", {
        linkAllowHosts: [],
        linkDenyHosts: [],
        ...config,
    } as unknown as AppConfig);
    ctx.plugin(linkPreviewPlugin);
    await ctx.start();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
        calls.push(input.href);
        return new Response(
            "<html><head><title>页面标题</title></head></html>",
            {
                headers: { "content-type": "text/html; charset=utf-8" },
            },
        );
    });
    return { service: ctx.get<LinkPreviewService>("link-preview"), calls };
};

const resolveTo = (records: { address: string; family: number }[]) => {
    lookup.mockResolvedValue(records as never);
};

describe("link preview guards", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        lookup.mockReset();
    });

    it("refuses a public domain that resolves to a private address", async () => {
        const { service, calls } = await make();
        resolveTo([{ address: "10.0.0.8", family: 4 }]);
        await expect(
            service.preview("http://rebind.example.com/x"),
        ).rejects.toThrow("不支持访问内网地址");
        expect(calls).toEqual([]);
    });

    it("refuses a host name that resolves to nothing", async () => {
        const { service, calls } = await make();
        lookup.mockRejectedValue(new Error("ENOTFOUND"));
        await expect(
            service.preview("http://gone.example.com/"),
        ).rejects.toThrow("无法解析该域名");
        expect(calls).toEqual([]);
    });

    it("applies the deny list to the host and its subdomains", async () => {
        const { service, calls } = await make({
            linkDenyHosts: ["blocked.example.com"],
        });
        resolveTo(PUBLIC);
        await expect(
            service.preview("http://blocked.example.com/x"),
        ).rejects.toThrow("该域名已被禁止访问");
        await expect(
            service.preview("http://a.b.blocked.example.com/x"),
        ).rejects.toThrow("该域名已被禁止访问");
        expect(calls).toEqual([]);
    });

    it("applies the allow list when it is not empty", async () => {
        const { service, calls } = await make({
            linkAllowHosts: ["good.example.com"],
        });
        resolveTo(PUBLIC);
        await expect(
            service.preview("http://other.example.com/"),
        ).rejects.toThrow("该域名不在允许的抓取范围内");
        expect(calls).toEqual([]);
        await expect(
            service.preview("http://good.example.com/"),
        ).resolves.toMatchObject({
            title: "页面标题",
            site: "good.example.com",
        });
        expect(calls).toEqual(["http://good.example.com/"]);
    });

    it("caches a preview until it is cleared", async () => {
        const { service, calls } = await make();
        resolveTo(PUBLIC);
        const url = "http://cached.example.com/post";
        await service.preview(url);
        await service.preview(url);
        expect(calls).toEqual([url]);
        service.clear();
        await service.preview(url);
        expect(calls).toEqual([url, url]);
    });
});
