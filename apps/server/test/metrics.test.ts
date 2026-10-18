import { Context } from "@plugim/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { metricsPlugin } from "../src/plugins/metrics";
import type { GatewayService, MetricsService } from "../src/types";

const setup = async () => {
    const ctx = new Context();
    const honoApp = new Hono();
    let connections = 0;
    ctx.provide<GatewayService>("gateway", {
        rpc() {},
        broadcast() {},
        emitToUser() {},
        setAuthenticator() {},
        verify: () => Promise.resolve(null),
        connections: () => connections,
        onlineUserIds: () => [],
        isUserOnline: () => false,
        kickUser() {},
        onOffline: () => () => undefined,
        hono: () => honoApp,
    });
    ctx.provide("config", { port: 3000 });
    await ctx.start();
    const plugin = metricsPlugin;
    const dispose = (await plugin.apply?.(ctx as never, {} as never)) as
        | (() => void)
        | undefined;
    const metrics = ctx.get<MetricsService>("metrics");
    return {
        metrics,
        honoApp,
        setConnections: (n: number) => {
            connections = n;
        },
        dispose,
    };
};

describe("metrics plugin", () => {
    it("counts rpc calls, errors and latency buckets", async () => {
        const { metrics } = await setup();
        metrics.observeRpc("auth.login", 3, true);
        metrics.observeRpc("auth.login", 30, true);
        metrics.observeRpc("auth.login", 900, false);
        const snap = metrics.snapshot();
        const login = snap.rpc.find((r) => r.method === "auth.login");
        expect(login).toBeDefined();
        expect(login?.calls).toBe(3);
        expect(login?.errors).toBe(1);
        expect(login?.maxMs).toBe(900);
        expect(login?.buckets.reduce((a, b) => a + b, 0)).toBe(3);
    });

    it("keeps histogram cumulative and includes +Inf", async () => {
        const { metrics } = await setup();
        for (const ms of [1, 8, 60, 300, 4000]) {
            metrics.observeRpc("chat.send", ms, true);
        }
        const text = metrics.prometheus();
        const buckets = [
            ...text.matchAll(
                /plugim_rpc_duration_ms_bucket\{method="chat\.send",le="([^"]+)"\} (\d+)/g,
            ),
        ].map((m) => [m[1], Number(m[2])]);
        expect(buckets.length).toBeGreaterThan(5);
        const values = buckets.map(([, v]) => v as number);
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
        }
        expect(values[values.length - 1]).toBe(5);
    });

    it("escapes labels so method names cannot break exposition", async () => {
        const { metrics } = await setup();
        metrics.observeRpc('weird"method\\name', 1, true);
        const text = metrics.prometheus();
        expect(text).toContain('method="weird\\"method\\\\name"');
    });

    it("reports connections, messages, http and process health", async () => {
        const { metrics, setConnections } = await setup();
        setConnections(4);
        metrics.setConnections(4);
        metrics.addMessage(3);
        metrics.observeHttp(12, true);
        metrics.observeHttp(30, false);
        const snap = metrics.snapshot();
        expect(snap.connections).toBe(4);
        expect(snap.messagesSent).toBe(3);
        expect(snap.httpRequests).toBe(2);
        expect(snap.httpErrors).toBe(1);
        expect(snap.httpDurationMs).toBe(42);
        expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
        expect(snap.memoryRssBytes).toBeGreaterThan(0);
        expect(snap.memoryHeapUsedBytes).toBeGreaterThan(0);
    });

    it("serves prometheus text and json endpoints", async () => {
        const { honoApp, metrics } = await setup();
        metrics.observeRpc("chat.list", 12, true);
        const text = await honoApp.request("/metrics");
        expect(text.status).toBe(200);
        expect(text.headers.get("content-type")).toContain(
            "text/plain; version=0.0.4",
        );
        const body = await text.text();
        expect(body).toContain("# TYPE plugim_rpc_calls_total counter");
        expect(body).toContain('plugim_rpc_calls_total{method="chat.list"} 1');
        expect(body).toContain("plugim_websocket_connections");

        const json = await honoApp.request("/metrics.json");
        expect(json.status).toBe(200);
        const parsed = (await json.json()) as { rpc: { method: string }[] };
        expect(parsed.rpc.map((r) => r.method)).toContain("chat.list");
    });

    it("resets counters without touching connection gauge", async () => {
        const { metrics } = await setup();
        metrics.observeRpc("auth.login", 5, true);
        metrics.addMessage(2);
        metrics.observeHttp(5, true);
        metrics.setConnections(7);
        metrics.reset();
        const snap = metrics.snapshot();
        expect(snap.rpc).toHaveLength(0);
        expect(snap.messagesSent).toBe(0);
        expect(snap.httpRequests).toBe(0);
        expect(snap.connections).toBe(7);
    });
});
