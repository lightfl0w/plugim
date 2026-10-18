import type { Plugin } from "@plugim/core";
import type { DndSettings, DndState } from "@plugim/protocol";
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
const DND_PREFIX = "dnd:";

export interface PushPayload {
    title: string;
    body: string;
    session: string;
}

export interface DndService {
    of(userId: string): Promise<DndSettings>;
    save(userId: string, settings: DndSettings): Promise<DndState>;
    suppressed(userIds: string[], session: string): Promise<string[]>;
}

export interface PushService {
    deliver(userIds: string[], payload: PushPayload): void;
    deliverAll(payload: PushPayload, exceptUserId: string): void;
}

const DEFAULT_DND: DndSettings = {
    enabled: false,
    start: "22:00",
    end: "08:00",
    mutedSessions: [],
};

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const normalizeDnd = (raw: unknown): DndSettings => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return { ...DEFAULT_DND };
    const value = raw as Partial<DndSettings>;
    const muted = Array.isArray(value.mutedSessions)
        ? [
              ...new Set(
                  value.mutedSessions.filter(
                      (item): item is string => typeof item === "string",
                  ),
              ),
          ].slice(0, 500)
        : [];
    const start = HHMM_RE.test(String(value.start ?? ""))
        ? String(value.start)
        : DEFAULT_DND.start;
    const end = HHMM_RE.test(String(value.end ?? ""))
        ? String(value.end)
        : DEFAULT_DND.end;
    return {
        enabled: value.enabled === true,
        start,
        end,
        mutedSessions: muted,
    };
};

const minutesOf = (hhmm: string): number => {
    const [h, m] = hhmm.split(":");
    return Number(h) * 60 + Number(m);
};

export const dndWindowActive = (settings: DndSettings, now: Date): boolean => {
    if (!settings.enabled) return false;
    const current = now.getHours() * 60 + now.getMinutes();
    const start = minutesOf(settings.start);
    const end = minutesOf(settings.end);
    if (start === end) return false;
    if (start < end) return current >= start && current < end;
    return current >= start || current < end;
};

export const dndNextStart = (
    settings: DndSettings,
    now: Date,
): string | null => {
    if (!settings.enabled) return null;
    const current = now.getHours() * 60 + now.getMinutes();
    const start = minutesOf(settings.start);
    if (current < start) {
        const at = new Date(now);
        at.setHours(Math.floor(start / 60), start % 60, 0, 0);
        return at.toISOString();
    }
    return null;
};

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

export const pushPlugin: Plugin = {
    name: "push",
    description: "Web Push 离线消息推送",
    provides: ["push", "dnd"],
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
            row: PushSubscriptionRow,
            payload: PushPayload,
        ): Promise<boolean> => {
            try {
                await webpush.sendNotification(
                    {
                        endpoint: row.endpoint,
                        keys: { p256dh: row.p256dh, auth: row.auth },
                    },
                    JSON.stringify(payload),
                );
                return true;
            } catch (err) {
                const code = (err as { statusCode?: number }).statusCode;
                if (code === 404 || code === 410) {
                    await pushes.remove(row.userId, row.endpoint);
                    return false;
                }
                ctx.log.warn("push send failed", code ?? String(err));
                return false;
            }
        };

        const deliver = (rows: PushSubscriptionRow[], payload: PushPayload) => {
            void Promise.all(rows.map((row) => send(row, payload))).catch(
                (err) => ctx.log.warn("push deliver failed", err),
            );
        };

        const dndCache = new Map<string, { at: number; value: DndSettings }>();
        const DND_TTL_MS = 30_000;

        const dndOf = async (userId: string): Promise<DndSettings> => {
            const cached = dndCache.get(userId);
            const now = Date.now();
            if (cached && now - cached.at < DND_TTL_MS) return cached.value;
            const raw = await settings.get(`${DND_PREFIX}${userId}`);
            let parsed: unknown = null;
            try {
                parsed = raw ? JSON.parse(raw) : null;
            } catch {
                parsed = null;
            }
            const value = normalizeDnd(parsed);
            if (dndCache.size > 5000) dndCache.clear();
            dndCache.set(userId, { at: now, value });
            return value;
        };

        const stateOf = (value: DndSettings): DndState => ({
            settings: value,
            active: dndWindowActive(value, new Date()),
            nextStartAt: dndNextStart(value, new Date()),
        });

        const dndService: DndService = {
            of: dndOf,
            async save(userId, next) {
                const value = normalizeDnd(next);
                dndCache.set(userId, { at: Date.now(), value });
                await settings.set(
                    `${DND_PREFIX}${userId}`,
                    JSON.stringify(value),
                );
                return stateOf(value);
            },
            async suppressed(userIds, session) {
                const now = new Date();
                const out: string[] = [];
                for (const id of new Set(userIds)) {
                    const value = await dndOf(id);
                    if (value.mutedSessions.includes(session)) {
                        out.push(id);
                        continue;
                    }
                    if (dndWindowActive(value, now)) out.push(id);
                }
                return out;
            },
        };

        ctx.provide<DndService>("dnd", dndService);

        gateway.rpc("dnd.get", async (_raw, conn) => {
            const user = requireUser(conn);
            return stateOf(await dndOf(user.id));
        });

        gateway.rpc("dnd.set", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as {
                enabled?: unknown;
                start?: unknown;
                end?: unknown;
                mutedSessions?: unknown;
            };
            const current = await dndOf(user.id);
            const muted = Array.isArray(params.mutedSessions)
                ? params.mutedSessions
                      .filter(
                          (item): item is string => typeof item === "string",
                      )
                      .slice(0, 500)
                : current.mutedSessions;
            const state = await dndService.save(user.id, {
                enabled:
                    params.enabled === undefined
                        ? current.enabled
                        : params.enabled === true,
                start:
                    params.start === undefined
                        ? current.start
                        : String(params.start),
                end:
                    params.end === undefined ? current.end : String(params.end),
                mutedSessions: muted,
            });
            return state;
        });

        gateway.rpc("dnd.mute", async (raw, conn) => {
            const user = requireUser(conn);
            const { session, on } = raw as unknown as {
                session?: unknown;
                on?: unknown;
            };
            const target = String(session ?? "").trim();
            if (!target) throw new Error("缺少会话");
            const current = await dndOf(user.id);
            const set = new Set(current.mutedSessions);
            if (on === false) set.delete(target);
            else set.add(target);
            return dndService.save(user.id, {
                ...current,
                mutedSessions: [...set],
            });
        });

        ctx.provide<PushService>("push", {
            deliver(userIds, payload) {
                const unique = [...new Set(userIds)];
                void dndService
                    .suppressed(unique, payload.session)
                    .then((blocked) => {
                        const allowed = unique.filter(
                            (id) => !blocked.includes(id),
                        );
                        const offline = allowed.filter(
                            (id) => !gateway.isUserOnline(id),
                        );
                        if (offline.length === 0) return;
                        return pushes
                            .ofUsers(offline)
                            .then((rows) => deliver(rows, payload));
                    })
                    .catch((err) => ctx.log.warn("push lookup failed", err));
            },
            deliverAll(payload, exceptUserId) {
                void pushes
                    .ofAll()
                    .then((rows) =>
                        dndService
                            .suppressed(
                                rows.map((row) => row.userId),
                                payload.session,
                            )
                            .then((blocked) =>
                                deliver(
                                    rows.filter(
                                        (row) =>
                                            row.userId !== exceptUserId &&
                                            !blocked.includes(row.userId) &&
                                            !gateway.isUserOnline(row.userId),
                                    ),
                                    payload,
                                ),
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
            if (value) await pushes.remove(user.id, value);
            return { subscriptions: (await pushes.ofUser(user.id)).length };
        });

        gateway.rpc("push.test", async (_raw, conn) => {
            const user = requireUser(conn);
            const rows = await pushes.ofUser(user.id);
            if (rows.length === 0) throw new Error("当前设备未开启推送");
            const results = await Promise.all(
                rows.map((row) =>
                    send(row, {
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
