import type { Plugin } from "@plugim/core";
import type { GatewayService, MetricsService } from "../types";

const BUCKET_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const SLOW_RPC_MS = Number(process.env.PLUGIM_SLOW_RPC_MS ?? 1500);
const LAG_SAMPLE_MS = 5000;
const MAX_TRACKED_METHODS = 500;

interface RpcStat {
    calls: number;
    errors: number;
    totalMs: number;
    maxMs: number;
    buckets: number[];
}

const newStat = (): RpcStat => ({
    calls: 0,
    errors: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: new Array(BUCKET_BOUNDS.length).fill(0) as number[],
});

const escapeLabel = (value: string): string =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");

export const metricsPlugin: Plugin = {
    name: "metrics",
    description: "运行指标采集与 Prometheus 暴露",
    provides: ["metrics"],
    inject: ["gateway", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");

        const rpc = new Map<string, RpcStat>();
        const startedAt = Date.now();
        let connections = 0;
        let messagesSent = 0;
        let httpRequests = 0;
        let httpErrors = 0;
        let httpDurationMs = 0;
        let eventLoopLagMs = 0;

        let lastTick = Date.now();
        const lagTimer = setInterval(() => {
            const now = Date.now();
            const drift = now - lastTick - LAG_SAMPLE_MS;
            lastTick = now;
            if (drift > 0) eventLoopLagMs = drift;
        }, LAG_SAMPLE_MS);
        lagTimer.unref?.();

        const service: MetricsService = {
            observeRpc(method, ms, ok) {
                let stat = rpc.get(method);
                if (!stat) {
                    if (rpc.size >= MAX_TRACKED_METHODS) return;
                    stat = newStat();
                    rpc.set(method, stat);
                }
                stat.calls += 1;
                stat.totalMs += ms;
                if (ms > stat.maxMs) stat.maxMs = ms;
                if (!ok) stat.errors += 1;
                for (let i = 0; i < BUCKET_BOUNDS.length; i++) {
                    if (ms <= BUCKET_BOUNDS[i]) {
                        stat.buckets[i] += 1;
                        break;
                    }
                }
                if (ms >= SLOW_RPC_MS) {
                    ctx.log.warn(`slow rpc ${method} took ${Math.round(ms)}ms`);
                }
            },
            setConnections(count) {
                connections = count;
            },
            addMessage(count = 1) {
                messagesSent += count;
            },
            observeHttp(ms, ok) {
                httpRequests += 1;
                httpDurationMs += ms;
                if (!ok) httpErrors += 1;
            },
            snapshot() {
                const mem = process.memoryUsage();
                return {
                    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
                    connections,
                    rpc: [...rpc.entries()].map(([method, stat]) => ({
                        method,
                        calls: stat.calls,
                        errors: stat.errors,
                        totalMs: stat.totalMs,
                        maxMs: stat.maxMs,
                        buckets: stat.buckets,
                    })),
                    messagesSent,
                    httpRequests,
                    httpErrors,
                    httpDurationMs,
                    eventLoopLagMs,
                    memoryRssBytes: mem.rss,
                    memoryHeapUsedBytes: mem.heapUsed,
                };
            },
            prometheus() {
                const out: string[] = [];
                const push = (
                    name: string,
                    help: string,
                    type: string,
                    body: string[],
                ) =>
                    out.push(
                        `# HELP ${name} ${help}`,
                        `# TYPE ${name} ${type}`,
                        ...body,
                    );

                push("plugim_uptime_seconds", "进程运行时长（秒）", "gauge", [
                    `plugim_uptime_seconds ${(
                        (Date.now() - startedAt) / 1000
                    ).toFixed(1)}`,
                ]);
                push(
                    "plugim_websocket_connections",
                    "当前 WebSocket 连接数",
                    "gauge",
                    [`plugim_websocket_connections ${connections}`],
                );
                push(
                    "plugim_messages_sent_total",
                    "服务端发出的消息总数",
                    "counter",
                    [`plugim_messages_sent_total ${messagesSent}`],
                );
                push("plugim_http_requests_total", "HTTP 请求总数", "counter", [
                    `plugim_http_requests_total ${httpRequests}`,
                ]);
                push("plugim_http_errors_total", "HTTP 请求错误数", "counter", [
                    `plugim_http_errors_total ${httpErrors}`,
                ]);
                push(
                    "plugim_event_loop_lag_ms",
                    "事件循环延迟（毫秒）",
                    "gauge",
                    [`plugim_event_loop_lag_ms ${eventLoopLagMs.toFixed(1)}`],
                );
                push("plugim_memory_rss_bytes", "进程常驻内存", "gauge", [
                    `plugim_memory_rss_bytes ${Math.round(
                        process.memoryUsage().rss,
                    )}`,
                ]);
                push(
                    "plugim_memory_heap_used_bytes",
                    "V8 堆已用内存",
                    "gauge",
                    [
                        `plugim_memory_heap_used_bytes ${Math.round(
                            process.memoryUsage().heapUsed,
                        )}`,
                    ],
                );

                const lines: string[] = [];
                for (const [method, stat] of rpc) {
                    const label = escapeLabel(method);
                    lines.push(
                        `plugim_rpc_calls_total{method="${label}"} ${stat.calls}`,
                        `plugim_rpc_errors_total{method="${label}"} ${stat.errors}`,
                        `plugim_rpc_duration_ms_sum{method="${label}"} ${stat.totalMs.toFixed(1)}`,
                        `plugim_rpc_duration_ms_max{method="${label}"} ${stat.maxMs.toFixed(1)}`,
                    );
                    let cumulative = 0;
                    for (let i = 0; i < BUCKET_BOUNDS.length; i++) {
                        cumulative += stat.buckets[i];
                        lines.push(
                            `plugim_rpc_duration_ms_bucket{method="${label}",le="${BUCKET_BOUNDS[i]}"} ${cumulative}`,
                        );
                    }
                    lines.push(
                        `plugim_rpc_duration_ms_bucket{method="${label}",le="+Inf"} ${stat.calls}`,
                    );
                }
                push(
                    "plugim_rpc_calls_total",
                    "RPC 调用次数",
                    "counter",
                    lines.filter((line) =>
                        line.startsWith("plugim_rpc_calls_total"),
                    ),
                );
                push(
                    "plugim_rpc_errors_total",
                    "RPC 失败次数",
                    "counter",
                    lines.filter((line) =>
                        line.startsWith("plugim_rpc_errors_total"),
                    ),
                );
                push(
                    "plugim_rpc_duration_ms_sum",
                    "RPC 累计耗时",
                    "counter",
                    lines.filter((line) =>
                        line.startsWith("plugim_rpc_duration_ms_sum"),
                    ),
                );
                push(
                    "plugim_rpc_duration_ms_max",
                    "RPC 单次最大耗时",
                    "gauge",
                    lines.filter((line) =>
                        line.startsWith("plugim_rpc_duration_ms_max"),
                    ),
                );
                push(
                    "plugim_rpc_duration_ms_bucket",
                    "RPC 耗时分布",
                    "histogram",
                    lines.filter((line) =>
                        line.startsWith("plugim_rpc_duration_ms_bucket"),
                    ),
                );

                return `${out.join("\n")}\n`;
            },
            reset() {
                rpc.clear();
                messagesSent = 0;
                httpRequests = 0;
                httpErrors = 0;
                httpDurationMs = 0;
            },
        };

        const app = gateway.hono();

        app.get("/metrics", (c) =>
            c.body(service.prometheus(), 200, {
                "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
            }),
        );

        app.get("/metrics.json", (c) => c.json(service.snapshot()));

        ctx.provide<MetricsService>("metrics", service);
        service.setConnections(gateway.connections());
        ctx.log.info("metrics enabled: /metrics, /metrics.json");

        return () => {
            clearInterval(lagTimer);
        };
    },
};
