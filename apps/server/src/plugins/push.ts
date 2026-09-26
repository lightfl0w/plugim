import type { Plugin } from "@plugim/core";
import webpush from "web-push";
import type {
    AuthUser,
    ConnInfo,
    GatewayService,
    PushStore,
    PushSubscriptionRow,
    SettingsStore,
} from "../types";
import type { AppConfig } from "./config";

const VAPID_PUBLIC = "vapid_public";
const VAPID_PRIVATE = "vapid_private";
const SUBJECT_FALLBACK = "mailto:admin@example.com";

export interface PushPayload {
    title: string;
    body: string;
    session: string;
}

export interface PushService {
    deliver(userIds: string[], payload: PushPayload): void;
    deliverAll(payload: PushPayload, exceptUserId: string): void;
}

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

export const pushPlugin: Plugin = {
    name: "push",
    description: "Web Push 离线消息推送",
    provides: ["push"],
    inject: ["config", "gateway", "pushes", "settings"],
    async apply(ctx) {
        const config = ctx.get<AppConfig>("config");
        const gateway = ctx.get<GatewayService>("gateway");
        const pushes = ctx.get<PushStore>("pushes");
        const settings = ctx.get<SettingsStore>("settings");

        let publicKey = config.vapidPublicKey.trim();
        let privateKey = config.vapidPrivateKey.trim();
        if (!publicKey || !privateKey) {
            publicKey = (await settings.get(VAPID_PUBLIC)) ?? "";
            privateKey = (await settings.get(VAPID_PRIVATE)) ?? "";
        }
        if (!publicKey || !privateKey) {
            const generated = webpush.generateVAPIDKeys();
            publicKey = generated.publicKey;
            privateKey = generated.privateKey;
            await settings.set(VAPID_PUBLIC, publicKey);
            await settings.set(VAPID_PRIVATE, privateKey);
            ctx.log.info("VAPID keys generated and stored");
        }
        webpush.setVapidDetails(
            config.vapidSubject.trim() || SUBJECT_FALLBACK,
            publicKey,
            privateKey,
        );

        const send = async (
            endpoint: string,
            p256dh: string,
            auth: string,
            payload: PushPayload,
        ): Promise<boolean> => {
            try {
                await webpush.sendNotification(
                    { endpoint, keys: { p256dh, auth } },
                    JSON.stringify(payload),
                );
                return true;
            } catch (err) {
                const code = (err as { statusCode?: number }).statusCode;
                if (code === 404 || code === 410) {
                    await pushes.remove(endpoint);
                    return false;
                }
                ctx.log.warn("push send failed", code ?? String(err));
                return false;
            }
        };

        const deliver = (rows: PushSubscriptionRow[], payload: PushPayload) => {
            void Promise.all(
                rows.map((row) =>
                    send(row.endpoint, row.p256dh, row.auth, payload),
                ),
            ).catch((err) => ctx.log.warn("push deliver failed", err));
        };

        ctx.provide<PushService>("push", {
            deliver(userIds, payload) {
                const offline = [...new Set(userIds)].filter(
                    (id) => !gateway.isUserOnline(id),
                );
                if (offline.length === 0) return;
                void pushes
                    .ofUsers(offline)
                    .then((rows) => deliver(rows, payload))
                    .catch((err) => ctx.log.warn("push lookup failed", err));
            },
            deliverAll(payload, exceptUserId) {
                void pushes
                    .ofAll()
                    .then((rows) =>
                        deliver(
                            rows.filter(
                                (row) =>
                                    row.userId !== exceptUserId &&
                                    !gateway.isUserOnline(row.userId),
                            ),
                            payload,
                        ),
                    )
                    .catch((err) => ctx.log.warn("push lookup failed", err));
            },
        });

        gateway.rpc("push.info", async (_raw, conn) => {
            const user = requireUser(conn);
            return {
                publicKey,
                subscriptions: (await pushes.ofUser(user.id)).length,
            };
        });

        gateway.rpc("push.subscribe", async (raw, conn) => {
            const user = requireUser(conn);
            const { subscription } = raw as unknown as {
                subscription?: {
                    endpoint?: unknown;
                    keys?: { p256dh?: unknown; auth?: unknown };
                };
            };
            const endpoint = String(subscription?.endpoint ?? "").trim();
            const p256dh = String(subscription?.keys?.p256dh ?? "").trim();
            const auth = String(subscription?.keys?.auth ?? "").trim();
            if (!endpoint || !p256dh || !auth)
                throw new Error("订阅信息不完整");
            await pushes.save({ userId: user.id, endpoint, p256dh, auth });
            return { subscriptions: (await pushes.ofUser(user.id)).length };
        });

        gateway.rpc("push.unsubscribe", async (raw, conn) => {
            const user = requireUser(conn);
            const { endpoint } = raw as unknown as { endpoint?: unknown };
            const value = String(endpoint ?? "").trim();
            if (value) await pushes.remove(value);
            return { subscriptions: (await pushes.ofUser(user.id)).length };
        });

        gateway.rpc("push.test", async (_raw, conn) => {
            const user = requireUser(conn);
            const rows = await pushes.ofUser(user.id);
            if (rows.length === 0) throw new Error("当前设备未开启推送");
            const results = await Promise.all(
                rows.map((row) =>
                    send(row.endpoint, row.p256dh, row.auth, {
                        title: "plugim",
                        body: "推送测试成功",
                        session: "",
                    }),
                ),
            );
            if (!results.some(Boolean)) throw new Error("推送发送失败");
            return { ok: true };
        });
        return undefined;
    },
};
