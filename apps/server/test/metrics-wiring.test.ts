import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@plugim/core";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/plugins/config";
import { gatewayPlugin } from "../src/plugins/gateway";
import { metricsPlugin } from "../src/plugins/metrics";
import { storagePlugin } from "../src/plugins/storage";
import type { GatewayService, MetricsService } from "../src/types";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const freePort = async (): Promise<number> => {
    const net = await import("node:net");
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const address = srv.address();
            const port =
                typeof address === "object" && address ? address.port : 0;
            srv.close(() => resolve(port));
        });
    });
};

const startLive = async () => {
    const dir = mkdtempSync(join(tmpdir(), "plugim-mwiring-"));
    const port = await freePort();
    const ctx = new Context();
    ctx.provide<AppConfig>("config", {
        port,
        dbDriver: "sqlite",
        dbUrl: "",
        dbFile: join(dir, "wiring.db"),
        logDir: "",
        defaultSession: "general",
        jwtSecret: "wiring-secret",
        bootstrapAdmins: [],
        allowRegister: true,
        inviteCode: "",
        vapidPublicKey: "",
        vapidPrivateKey: "",
        vapidSubject: "",
        iceServers: [],
        storageDriver: "local",
        storageDir: join(dir, "uploads"),
        uploadLimitMb: 20,
        s3Endpoint: "",
        s3Region: "",
        s3Bucket: "",
        s3AccessKey: "",
        s3SecretKey: "",
        s3PathStyle: "",
        s3PublicBase: "",
        linkAllowHosts: [],
        linkDenyHosts: [],
    });
    ctx.plugin(storagePlugin);
    ctx.plugin(gatewayPlugin);
    ctx.plugin(metricsPlugin);
    await ctx.start();
    const gateway = ctx.get<GatewayService>("gateway");
    const metrics = ctx.get<MetricsService>("metrics");
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${base}/health`)).ok) break;
        } catch {}
        await wait(100);
    }
    return {
        base,
        metrics,
        gateway,
        stop: () => ctx.stop(),
    };
};

describe("metrics 与 gateway 接线", () => {
    it("metrics 在 gateway 之后启动也能接到 dispatch 埋点", async () => {
        const live = await startLive();
        try {
            await fetch(`${live.base}/rpc/install.status`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ params: {} }),
            });
            const snap = live.metrics.snapshot();
            const stat = snap.rpc.find((r) => r.method === "install.status");
            expect(stat).toBeDefined();
            expect(stat?.calls).toBeGreaterThanOrEqual(1);
        } finally {
            await live.stop();
        }
    }, 20_000);

    it("未知方法计入错误计数", async () => {
        const live = await startLive();
        try {
            const res = await fetch(`${live.base}/rpc/nope.method`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ params: {} }),
            });
            expect(res.status).toBe(400);
            const snap = live.metrics.snapshot();
            const unknown = snap.rpc.find((r) => r.method === "nope.method");
            expect(unknown?.errors).toBeGreaterThanOrEqual(1);
        } finally {
            await live.stop();
        }
    }, 20_000);

    it("HTTP 请求计入请求数，/metrics 自身不计入", async () => {
        const live = await startLive();
        try {
            const before = live.metrics.snapshot().httpRequests;
            await fetch(`${live.base}/metrics`);
            expect(live.metrics.snapshot().httpRequests).toBe(before);

            await fetch(`${live.base}/health`);
            expect(live.metrics.snapshot().httpRequests).toBeGreaterThan(
                before,
            );
        } finally {
            await live.stop();
        }
    }, 20_000);

    it("广播消息事件计入消息总数", async () => {
        const live = await startLive();
        try {
            const before = live.metrics.snapshot().messagesSent;
            live.gateway.broadcast("message:new", { message: {} });
            expect(live.metrics.snapshot().messagesSent).toBe(before + 1);

            live.gateway.broadcast("presence:update", {});
            expect(live.metrics.snapshot().messagesSent).toBe(before + 1);
        } finally {
            await live.stop();
        }
    }, 20_000);
});
