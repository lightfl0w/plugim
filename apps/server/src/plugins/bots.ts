import { createHash, randomBytes } from "node:crypto";
import type { Plugin } from "@plugim/core";
import type {
    BotApp,
    BotAppCreated,
    BotEvent,
    BotHook,
    BotInboundParams,
    BotScope,
    ChatMessage,
    MessageKind,
} from "@plugim/protocol";
import { BOT_EVENTS, BOT_SCOPES } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    BotHookRow,
    BotsStore,
    ChatService,
    ConnInfo,
    GatewayService,
    GroupsStore,
} from "../types";

const NAME_MAX = 40;
const URL_MAX = 500;
const TOKEN_PREFIX = "pgm_";
const CONTENT_MAX = 8000;
const DELIVERY_TIMEOUT_MS = 5000;
const DELIVERY_MAX_ATTEMPTS = 3;

const TOKEN_RE = /^pgm_[A-Za-z0-9_-]{32}$/;
const URL_RE = /^https?:\/\/\S+$/i;

export interface BotsService {
    emit(event: BotEvent, payload: unknown): void;
}

const hashToken = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

const toApp = (row: {
    id: string;
    name: string;
    owner: string;
    scopes: BotScope[];
    createdAt: string;
    lastUsedAt: string | null;
    tokenHash: string;
}): BotApp => ({
    id: row.id,
    name: row.name,
    owner: row.owner,
    scopes: row.scopes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    tokenPreview: `${row.tokenHash.slice(0, 8)}…`,
});

const toHook = (row: BotHook) => ({
    id: row.id,
    botId: row.botId,
    botName: row.botName,
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    createdAt: row.createdAt,
    failures: row.failures,
    lastError: row.lastError,
});

const scopedOf = (raw: unknown): BotScope[] => {
    if (!Array.isArray(raw)) return [];
    return [
        ...new Set(
            raw.filter((item): item is BotScope =>
                (BOT_SCOPES as readonly string[]).includes(String(item)),
            ),
        ),
    ];
};

const eventsOf = (raw: unknown): BotEvent[] => {
    if (!Array.isArray(raw)) return [];
    return [
        ...new Set(
            raw.filter((item): item is BotEvent =>
                (BOT_EVENTS as readonly string[]).includes(String(item)),
            ),
        ),
    ].slice(0, 20);
};

export const botsPlugin: Plugin = {
    name: "bots",
    description: "机器人应用、开放 API 与事件订阅",
    provides: ["bots-rpc", "bots"],
    inject: ["gateway", "bots", "accounts", "groups"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const bots = ctx.get<BotsStore>("bots");
        const accounts = ctx.get<AccountsStore>("accounts");
        const groups = ctx.get<GroupsStore>("groups");
        const chatOf = (): ChatService => ctx.get<ChatService>("chat");

        const emit = (event: BotEvent, payload: unknown) => {
            void bots
                .hooksOfEvent(event)
                .then((hooks) =>
                    Promise.all(
                        hooks.map((hook) => deliver(hook, event, payload)),
                    ),
                )
                .catch((err) => ctx.log.warn("bot hook dispatch failed", err));
        };

        const deliver = async (
            hook: BotHookRow,
            event: BotEvent,
            payload: unknown,
        ) => {
            const body = JSON.stringify({
                event,
                bot: hook.botName,
                at: new Date().toISOString(),
                data: payload,
            });
            const signature = createHash("sha256")
                .update(`${hook.secret}.${body}`)
                .digest("hex");
            for (let attempt = 1; attempt <= DELIVERY_MAX_ATTEMPTS; attempt++) {
                const controller = new AbortController();
                const timer = setTimeout(
                    () => controller.abort(),
                    DELIVERY_TIMEOUT_MS,
                );
                let retryable = true;
                try {
                    const res = await fetch(hook.url, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "x-plugim-event": event,
                            "x-plugim-signature": signature,
                        },
                        body,
                        signal: controller.signal,
                    });
                    if (res.ok) {
                        await bots.reportHook(hook.id, true, null);
                        return;
                    }
                    retryable = res.status >= 500 || res.status === 429;
                    if (!retryable) throw new Error(`HTTP ${res.status}`);
                } catch (err) {
                    if (!retryable || attempt === DELIVERY_MAX_ATTEMPTS) {
                        await bots.reportHook(
                            hook.id,
                            false,
                            String(
                                err instanceof Error ? err.message : err,
                            ).slice(0, 200),
                        );
                        return;
                    }
                } finally {
                    clearTimeout(timer);
                }
            }
        };

        gateway.rpc("bots.apps", async (_raw, conn) => {
            const user = requireUser(conn);
            const rows = await bots.listApps(user.id);
            return rows.filter((row) => !row.revoked).map(toApp);
        });

        gateway.rpc("bots.app.create", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as {
                name?: unknown;
                scopes?: unknown;
            };
            const name = String(params.name ?? "")
                .trim()
                .slice(0, NAME_MAX);
            if (!name) throw new Error("请填写应用名称");
            const scopes = scopedOf(params.scopes);
            if (scopes.length === 0) scopes.push("messages:write" as BotScope);
            const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
            const row = await bots.createApp({
                ownerId: user.id,
                name,
                tokenHash: hashToken(token),
                scopes,
            });
            return { ...toApp(row), token } satisfies BotAppCreated;
        });

        gateway.rpc("bots.app.revoke", async (raw, conn) => {
            const user = requireUser(conn);
            const id = String(
                (raw as unknown as { id?: unknown }).id ?? "",
            ).trim();
            if (!id) throw new Error("缺少应用");
            if (!(await bots.revokeApp(user.id, id)))
                throw new Error("应用不存在");
            return { ok: true };
        });

        gateway.rpc("bots.hooks", async (_raw, conn) => {
            const user = requireUser(conn);
            return (await bots.listHooks(user.id)).map(toHook);
        });

        gateway.rpc("bots.hook.create", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as {
                url?: unknown;
                events?: unknown;
            };
            const url = String(params.url ?? "")
                .trim()
                .slice(0, URL_MAX);
            if (!URL_RE.test(url))
                throw new Error("回调地址必须是 http(s) URL");
            const events = eventsOf(params.events);
            if (events.length === 0) throw new Error("请至少选择一个事件");
            const owned = (await bots.listApps(user.id)).filter(
                (row) => !row.revoked,
            );
            if (owned.length === 0) throw new Error("请先创建应用");
            const row = await bots.createHook({
                botId: owned[0].id,
                url,
                secret: randomBytes(24).toString("base64url"),
                events,
            });
            return { ...toHook(row), secret: row.secret };
        });

        gateway.rpc("bots.hook.toggle", async (raw, conn) => {
            const user = requireUser(conn);
            const params = raw as unknown as {
                id?: unknown;
                enabled?: unknown;
            };
            const id = String(params.id ?? "").trim();
            if (!id) throw new Error("缺少订阅");
            if (
                !(await bots.setHookEnabled(
                    user.id,
                    id,
                    params.enabled === true,
                ))
            )
                throw new Error("订阅不存在");
            return { ok: true };
        });

        gateway.rpc("bots.hook.remove", async (raw, conn) => {
            const user = requireUser(conn);
            const id = String(
                (raw as unknown as { id?: unknown }).id ?? "",
            ).trim();
            if (!id) throw new Error("缺少订阅");
            if (!(await bots.removeHook(user.id, id)))
                throw new Error("订阅不存在");
            return { ok: true };
        });

        const appByToken = async (token: string) => {
            const value = String(token ?? "").trim();
            if (!TOKEN_RE.test(value)) return null;
            return bots.byToken(hashToken(value));
        };

        const ownerUserOf = async (app: {
            ownerId: string;
        }): Promise<AuthUser | null> => {
            const owner = await accounts.byId(app.ownerId);
            return owner ? { id: owner.id, username: owner.username } : null;
        };

        const assertSessionReachable = async (
            user: AuthUser,
            session: string,
        ) => {
            if (session.startsWith("g:")) {
                const members = await groups.membersOf(session.slice(2));
                if (!members.some((m) => m.userId === user.id))
                    throw new Error("应用所有者不在该群中");
                return;
            }
            if (session.startsWith("p2p:")) {
                const peerName = session.slice(4).trim().toLowerCase();
                if (!peerName) throw new Error("缺少对端用户名");
                if (!(await accounts.byUsername(peerName)))
                    throw new Error("目标用户不存在");
                return;
            }
            throw new Error("仅支持 p2p: 与 g: 会话");
        };

        const tokenOf = (c: {
            req: { header(k: string): string | undefined; url: string };
        }) => {
            const header = c.req.header("authorization");
            return header?.startsWith("Bearer ")
                ? header.slice(7).trim()
                : (new URL(c.req.url).searchParams.get("token") ?? "").trim();
        };

        gateway.hono().post("/open/message", async (c) => {
            const app = await appByToken(tokenOf(c));
            if (!app)
                return c.json({ ok: false, message: "无效的应用令牌" }, 401);
            if (!app.scopes.includes("messages:write"))
                return c.json(
                    { ok: false, message: "该应用没有发消息权限" },
                    403,
                );
            const body = (await c.req
                .json()
                .catch(() => ({}))) as BotInboundParams;
            const user = await ownerUserOf(app);
            if (!user)
                return c.json({ ok: false, message: "应用所有者不存在" }, 404);
            const session = String(body.session ?? "").trim();
            if (!session)
                return c.json({ ok: false, message: "缺少 session" }, 400);
            const kind: MessageKind =
                body.kind === "notice" ? "notice" : "text";
            let content = String(body.content ?? "").trim();
            if (!content)
                return c.json({ ok: false, message: "缺少 content" }, 400);
            const title = String(body.title ?? "")
                .trim()
                .slice(0, 60);
            if (kind === "notice" && title)
                content = `【${title}】\n${content}`;
            if (content.length > CONTENT_MAX)
                content = content.slice(0, CONTENT_MAX);
            try {
                await assertSessionReachable(user, session);
                const message = await chatOf().sendTo(user, session, {
                    content,
                    quote: null,
                    mentions: null,
                    kind,
                    file: null,
                });
                emit("message.new", { session, message });
                return c.json({
                    ok: true,
                    result: { id: message.id, seq: message.seq },
                });
            } catch (err) {
                return c.json(
                    {
                        ok: false,
                        message: String(
                            err instanceof Error ? err.message : err,
                        ),
                    },
                    400,
                );
            }
        });

        gateway.hono().get("/open/messages", async (c) => {
            const app = await appByToken(tokenOf(c));
            if (!app)
                return c.json({ ok: false, message: "无效的应用令牌" }, 401);
            if (!app.scopes.includes("messages:read"))
                return c.json(
                    { ok: false, message: "该应用没有读消息权限" },
                    403,
                );
            const user = await ownerUserOf(app);
            if (!user)
                return c.json({ ok: false, message: "应用所有者不存在" }, 404);
            const session = String(c.req.query("session") ?? "").trim();
            if (!session)
                return c.json({ ok: false, message: "缺少 session" }, 400);
            const limit = Math.min(
                Math.max(1, Math.floor(Number(c.req.query("limit") ?? 20))),
                100,
            );
            try {
                const messages: ChatMessage[] = await chatOf().listFor(
                    user,
                    session,
                    limit,
                );
                return c.json({ ok: true, result: { messages } });
            } catch (err) {
                return c.json(
                    {
                        ok: false,
                        message: String(
                            err instanceof Error ? err.message : err,
                        ),
                    },
                    400,
                );
            }
        });

        gateway.hono().get("/open/whoami", async (c) => {
            const app = await appByToken(tokenOf(c));
            if (!app)
                return c.json({ ok: false, message: "无效的应用令牌" }, 401);
            return c.json({ ok: true, result: toApp(app) });
        });

        ctx.provide<BotsService>("botEvents", { emit });

        return undefined;
    },
};
