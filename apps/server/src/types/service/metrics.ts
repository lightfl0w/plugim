export interface RpcMetric {
    method: string;
    calls: number;
    errors: number;
    totalMs: number;
    maxMs: number;
    buckets: number[];
}

export interface MetricsSnapshot {
    uptimeSec: number;
    connections: number;
    rpc: RpcMetric[];
    messagesSent: number;
    httpRequests: number;
    httpErrors: number;
    httpDurationMs: number;
    eventLoopLagMs: number;
    memoryRssBytes: number;
    memoryHeapUsedBytes: number;
}

export interface MetricsService {
    observeRpc(method: string, ms: number, ok: boolean): void;
    setConnections(count: number): void;
    addMessage(count?: number): void;
    observeHttp(ms: number, ok: boolean): void;
    snapshot(): MetricsSnapshot;
    prometheus(): string;
    reset(): void;
}
