import type { Context } from "@plugim/core";
import type {
    AuthDevice,
    BotApp,
    BotHook,
    BotScope,
    DndState,
} from "@plugim/protocol";
import { BOT_EVENTS, BOT_SCOPES } from "@plugim/protocol";
import {
    BellOffIcon,
    BotIcon,
    CopyIcon,
    MonitorSmartphoneIcon,
    ShieldCheckIcon,
    Trash2Icon,
    WebhookIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import type { RpcService } from "./connection";
import {
    codeClass,
    Field,
    inputClass,
    Note,
    PageShell,
    Panel,
    panelBody,
    panelRow,
    pillClass,
} from "./ui-layout";
import { apiOrigin } from "./ui-shared";
import type { UiService } from "./ui-types";

const formatTime = (iso: string) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "-" : at.toLocaleString();
};

const SCOPE_LABELS: Record<BotScope, string> = {
    "messages:read": "读取消息",
    "messages:write": "发送消息",
    events: "接收事件",
};

const EVENT_LABELS: Record<string, string> = {
    "message.new": "新消息",
    "message.recalled": "消息撤回",
    "message.edited": "消息编辑",
    "read.update": "已读回执",
    "group.join": "入群申请",
    "redpacket.update": "红包状态",
};

export const uiSecuritySetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const rpc = ctx.get<RpcService>("rpc");

    const DndPanel = () => {
        const [state, setState] = useState<DndState | null>(null);
        const [error, setError] = useState<string | null>(null);

        const load = useCallback(async () => {
            try {
                setState((await rpc.call("dnd.get", {})) as DndState);
            } catch (err) {
                setError(err instanceof Error ? err.message : "读取失败");
            }
        }, []);

        useEffect(() => {
            void load();
        }, [load]);

        const save = async (next: Partial<DndState["settings"]>) => {
            if (!state) return;
            setError(null);
            try {
                setState(
                    (await rpc.call("dnd.set", {
                        ...state.settings,
                        ...next,
                    })) as DndState,
                );
            } catch (err) {
                setError(err instanceof Error ? err.message : "保存失败");
            }
        };

        if (!state) {
            return (
                <Panel
                    id="dnd"
                    icon={<BellOffIcon />}
                    title="免打扰"
                    desc="在静默时段内不推送通知，消息仍会正常送达并计入未读。"
                >
                    <Note>{error ?? "加载中…"}</Note>
                </Panel>
            );
        }

        return (
            <Panel
                id="dnd"
                icon={<BellOffIcon />}
                title="免打扰"
                desc="在静默时段内不推送通知，消息仍会正常送达并计入未读。"
            >
                <div className={panelRow}>
                    <Field
                        title="启用免打扰时段"
                        desc={
                            state.active
                                ? "当前处于静默时段，不会收到推送通知"
                                : state.settings.enabled
                                  ? `每天 ${state.settings.start} – ${state.settings.end} 静默`
                                  : "关闭时段，消息会正常推送"
                        }
                    />
                    <Switch
                        checked={state.settings.enabled}
                        onToggle={() =>
                            void save({
                                enabled: !state.settings.enabled,
                            })
                        }
                    />
                </div>
                <div className={panelRow}>
                    <Field
                        title="静默时段"
                        desc="跨午夜时段（例如 22:00 – 08:00）会自动识别；开始与结束相同视为不启用。"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                        <input
                            type="time"
                            value={state.settings.start}
                            onChange={(e) =>
                                void save({ start: e.target.value })
                            }
                            className={`${inputClass} w-28`}
                        />
                        <span className="text-xs text-muted-foreground">
                            至
                        </span>
                        <input
                            type="time"
                            value={state.settings.end}
                            onChange={(e) => void save({ end: e.target.value })}
                            className={`${inputClass} w-28`}
                        />
                    </div>
                </div>
                <div className={panelRow}>
                    <Field
                        title="单独静音的会话"
                        desc={
                            state.settings.mutedSessions.length === 0
                                ? "暂无静音会话。可在聊天窗口的消息菜单里选择「静音此会话」。"
                                : state.settings.mutedSessions.join("、")
                        }
                    />
                </div>
                {error ? <Note tone="error">{error}</Note> : null}
            </Panel>
        );
    };

    const DevicesPanel = () => {
        const [devices, setDevices] = useState<AuthDevice[]>([]);
        const [totpEnabled, setTotpEnabled] = useState(false);
        const [error, setError] = useState<string | null>(null);
        const [secret, setSecret] = useState<string | null>(null);
        const [otpauth, setOtpauth] = useState("");
        const [code, setCode] = useState("");
        const [busy, setBusy] = useState(false);

        const load = useCallback(async () => {
            try {
                const res = (await rpc.call("auth.sessions", {})) as {
                    devices: AuthDevice[];
                    totpEnabled: boolean;
                };
                setDevices(res.devices);
                setTotpEnabled(res.totpEnabled);
            } catch (err) {
                setError(err instanceof Error ? err.message : "读取失败");
            }
        }, []);

        useEffect(() => {
            void load();
        }, [load]);

        const revoke = async (id: string) => {
            setError(null);
            try {
                await rpc.call("auth.session.revoke", { id });
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "下线失败");
            }
        };

        const revokeOthers = async () => {
            setBusy(true);
            setError(null);
            try {
                await rpc.call("auth.sessions.revokeOthers", {});
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "操作失败");
            } finally {
                setBusy(false);
            }
        };

        const startTotp = async () => {
            setBusy(true);
            setError(null);
            try {
                const res = (await rpc.call("auth.totp.setup", {})) as {
                    secret: string;
                    otpauth: string;
                };
                setSecret(res.secret);
                setOtpauth(res.otpauth);
            } catch (err) {
                setError(err instanceof Error ? err.message : "生成失败");
            } finally {
                setBusy(false);
            }
        };

        const confirmTotp = async () => {
            setBusy(true);
            setError(null);
            try {
                await rpc.call("auth.totp.enable", { code });
                setSecret(null);
                setCode("");
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "校验失败");
            } finally {
                setBusy(false);
            }
        };

        const disableTotp = async () => {
            const password = window.prompt("请输入当前密码以关闭动态口令");
            if (!password) return;
            setBusy(true);
            setError(null);
            try {
                await rpc.call("auth.totp.disable", { password });
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "关闭失败");
            } finally {
                setBusy(false);
            }
        };

        const others = devices.filter((d) => !d.current).length;

        return (
            <Panel
                id="devices"
                icon={<MonitorSmartphoneIcon />}
                title="多端设备"
                desc="每台设备独立记录登录状态，下线后该设备的登录立刻失效，无需等待令牌过期。"
            >
                <div className={panelRow}>
                    <Field
                        title="已登录设备"
                        desc={
                            others === 0
                                ? "当前只有这台设备在线"
                                : `另有 ${others} 台设备处于登录状态`
                        }
                    />
                    <Button
                        variant="outline"
                        disabled={busy || others === 0}
                        onClick={() => void revokeOthers()}
                    >
                        下线其他设备（{others}）
                    </Button>
                </div>
                {devices.map((device) => (
                    <div key={device.id} className={panelRow}>
                        <Field
                            title={device.label}
                            desc={`${formatTime(device.lastSeenAt)}${device.ip ? ` ${device.ip}` : ""}`}
                        >
                            {device.current ? (
                                <span className="mt-1 inline-flex w-fit rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                                    当前设备
                                </span>
                            ) : null}
                        </Field>
                        <Button
                            variant="ghost"
                            disabled={device.current}
                            onClick={() => void revoke(device.id)}
                        >
                            下线
                        </Button>
                    </div>
                ))}
                <div className={panelRow}>
                    <Field
                        title="两步验证（TOTP）"
                        desc={
                            totpEnabled
                                ? "已开启，登录时需输入验证器生成的 6 位动态口令"
                                : "未开启，建议管理员与研发账号开启"
                        }
                    />
                    <Button
                        variant={totpEnabled ? "ghost" : "outline"}
                        disabled={busy}
                        onClick={() =>
                            void (totpEnabled ? disableTotp() : startTotp())
                        }
                    >
                        {totpEnabled ? "关闭两步验证" : "开启两步验证"}
                    </Button>
                </div>
                {secret ? (
                    <div className={panelBody}>
                        <p className="text-xs font-medium">
                            用验证器扫码，或手动录入下面的密钥
                        </p>
                        <div className="flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2.5">
                            <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
                                {secret}
                            </code>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                title="复制密钥"
                                onClick={() =>
                                    void navigator.clipboard.writeText(secret)
                                }
                            >
                                <CopyIcon />
                            </Button>
                        </div>
                        <p className="break-all text-[10px] leading-relaxed text-muted-foreground">
                            {otpauth}
                        </p>
                        <div className="flex flex-wrap items-center gap-3">
                            <input
                                value={code}
                                onChange={(e) => setCode(e.target.value)}
                                placeholder="6 位动态口令"
                                className={`${inputClass} w-36 tracking-[0.3em]`}
                            />
                            <Button
                                disabled={busy || code.length !== 6}
                                onClick={() => void confirmTotp()}
                            >
                                确认开启
                            </Button>
                            <Button
                                variant="ghost"
                                onClick={() => setSecret(null)}
                            >
                                取消
                            </Button>
                        </div>
                    </div>
                ) : null}
                {error ? <Note tone="error">{error}</Note> : null}
            </Panel>
        );
    };

    const BotsPanel = () => {
        const [apps, setApps] = useState<BotApp[]>([]);
        const [hooks, setHooks] = useState<BotHook[]>([]);
        const [issued, setIssued] = useState<string | null>(null);
        const [name, setName] = useState("");
        const [scopes, setScopes] = useState<BotScope[]>(["messages:write"]);
        const [url, setUrl] = useState("");
        const [events, setEvents] = useState<string[]>(["message.new"]);
        const [error, setError] = useState<string | null>(null);

        const load = useCallback(async () => {
            try {
                setApps((await rpc.call("bots.apps", {})) as BotApp[]);
                setHooks((await rpc.call("bots.hooks", {})) as BotHook[]);
            } catch (err) {
                setError(err instanceof Error ? err.message : "读取失败");
            }
        }, []);

        useEffect(() => {
            void load();
        }, [load]);

        const createApp = async () => {
            setError(null);
            try {
                const res = (await rpc.call("bots.app.create", {
                    name,
                    scopes,
                })) as BotApp & { token: string };
                setIssued(res.token);
                setName("");
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "创建失败");
            }
        };

        const revokeApp = async (id: string) => {
            setError(null);
            try {
                await rpc.call("bots.app.revoke", { id });
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "吊销失败");
            }
        };

        const createHook = async () => {
            setError(null);
            try {
                await rpc.call("bots.hook.create", { url, events });
                setUrl("");
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "订阅失败");
            }
        };

        const toggleHook = async (id: string, enabled: boolean) => {
            setError(null);
            try {
                await rpc.call("bots.hook.toggle", { id, enabled });
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "操作失败");
            }
        };

        const removeHook = async (id: string) => {
            setError(null);
            try {
                await rpc.call("bots.hook.remove", { id });
                await load();
            } catch (err) {
                setError(err instanceof Error ? err.message : "删除失败");
            }
        };

        const toggle = <T,>(list: T[], value: T, set: (v: T[]) => void) => {
            set(
                list.includes(value)
                    ? list.filter((item) => item !== value)
                    : [...list, value],
            );
        };

        const origin = apiOrigin();

        return (
            <>
                <Panel
                    id="apps"
                    icon={<BotIcon />}
                    title="机器人应用"
                    desc="为 CI、审批、告警等系统签发独立令牌，令牌只存哈希，明文仅在创建时展示一次。"
                >
                    <div className={panelRow}>
                        <Field
                            title="应用名称"
                            desc="用于区分不同接入方，例如「CI 通知」"
                        >
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="新应用名称"
                                className={`${inputClass} mt-1.5 w-full max-w-xs`}
                            />
                        </Field>
                    </div>
                    <div className={panelRow}>
                        <Field
                            title="授权范围"
                            desc="按最小权限授予；吊销后该令牌立即失效。"
                        />
                        <div className="flex flex-wrap gap-2">
                            {BOT_SCOPES.map((scope) => (
                                <button
                                    key={scope}
                                    type="button"
                                    onClick={() =>
                                        toggle(scopes, scope, setScopes)
                                    }
                                    className={pillClass(
                                        scopes.includes(scope),
                                    )}
                                >
                                    {SCOPE_LABELS[scope]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className={panelRow}>
                        <Field
                            title="创建应用"
                            desc="创建后会立即签发一枚访问令牌。"
                        />
                        <Button
                            disabled={!name.trim()}
                            onClick={() => void createApp()}
                        >
                            创建并签发令牌
                        </Button>
                    </div>
                    {issued ? (
                        <div className={panelBody}>
                            <p className="text-xs font-medium text-primary">
                                令牌只显示一次，请立即保存
                            </p>
                            <div className="flex items-start gap-2 rounded-lg bg-primary/5 px-3 py-2.5 ring-1 ring-primary/20">
                                <code className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
                                    {issued}
                                </code>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    title="复制令牌"
                                    onClick={() =>
                                        void navigator.clipboard.writeText(
                                            issued,
                                        )
                                    }
                                >
                                    <CopyIcon />
                                </Button>
                            </div>
                            <div>
                                <Button
                                    variant="ghost"
                                    onClick={() => setIssued(null)}
                                >
                                    我已保存
                                </Button>
                            </div>
                        </div>
                    ) : null}
                    {apps.map((app) => (
                        <div key={app.id} className={panelRow}>
                            <Field
                                title={app.name}
                                desc={`${app.scopes
                                    .map((s) => SCOPE_LABELS[s])
                                    .join("、")} ${
                                    app.lastUsedAt
                                        ? `最近使用 ${formatTime(app.lastUsedAt)}`
                                        : "尚未使用"
                                }`}
                            >
                                <code className="mt-1 inline-flex w-fit rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                                    {app.tokenPreview}
                                </code>
                            </Field>
                            <Button
                                variant="ghost"
                                onClick={() => void revokeApp(app.id)}
                            >
                                吊销
                            </Button>
                        </div>
                    ))}
                    {apps.length === 0 ? (
                        <Note>
                            还没有应用。创建一枚令牌即可通过开放 API 推消息。
                        </Note>
                    ) : null}
                    {error ? <Note tone="error">{error}</Note> : null}
                </Panel>

                <Panel
                    id="hooks"
                    icon={<WebhookIcon />}
                    title="事件订阅"
                    desc="服务端在事件发生后向你的回调地址发起带签名的 POST 请求。"
                >
                    <div className={panelRow}>
                        <Field
                            title="新增订阅"
                            desc="需先创建至少一个应用；仅 5xx 与 429 会重试，最多 3 次。"
                        >
                            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                <input
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    placeholder="https://ci.example.com/hook"
                                    className={`${inputClass} min-w-48 flex-1`}
                                />
                                <Button
                                    variant="outline"
                                    disabled={!url.trim() || apps.length === 0}
                                    onClick={() => void createHook()}
                                >
                                    添加订阅
                                </Button>
                            </div>
                        </Field>
                    </div>
                    <div className={panelRow}>
                        <Field
                            title="订阅事件"
                            desc="新建订阅时默认勾选以下事件。"
                        />
                        <div className="flex flex-wrap gap-2">
                            {BOT_EVENTS.map((event) => (
                                <button
                                    key={event}
                                    type="button"
                                    onClick={() =>
                                        toggle(events, event, setEvents)
                                    }
                                    className={pillClass(
                                        events.includes(event),
                                    )}
                                >
                                    {EVENT_LABELS[event] ?? event}
                                </button>
                            ))}
                        </div>
                    </div>
                    {hooks.map((hook) => (
                        <div key={hook.id} className={panelRow}>
                            <Field
                                title={hook.url}
                                desc={`${hook.events
                                    .map((e) => EVENT_LABELS[e] ?? e)
                                    .join("、")}${
                                    hook.lastError
                                        ? ` 失败 ${hook.failures} 次：${hook.lastError}`
                                        : ""
                                }`}
                            />
                            <Switch
                                checked={hook.enabled}
                                onToggle={() =>
                                    void toggleHook(hook.id, !hook.enabled)
                                }
                            />
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                title="删除订阅"
                                onClick={() => void removeHook(hook.id)}
                            >
                                <Trash2Icon />
                            </Button>
                        </div>
                    ))}
                    {hooks.length === 0 ? <Note>还没有事件订阅。</Note> : null}
                </Panel>

                <Panel
                    icon={<ShieldCheckIcon />}
                    title="调用示例"
                    desc="用应用令牌直接向会话推送消息，无需经过前端。"
                >
                    <div className={panelRow}>
                        <Field
                            title="接口地址"
                            desc={
                                import.meta.env.DEV
                                    ? "当前为开发环境，指向本地服务端；生产环境为当前站点域名。"
                                    : "与当前站点同源。"
                            }
                        >
                            <code className="mt-1 inline-flex w-fit rounded-md bg-muted/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                                {origin}
                            </code>
                        </Field>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                                void navigator.clipboard.writeText(origin)
                            }
                        >
                            复制
                        </Button>
                    </div>
                    <div className={panelBody}>
                        <code className={codeClass}>
                            {`curl -X POST ${origin}/open/message \\
  -H "Authorization: Bearer <app_token>" \\
  -H "content-type: application/json" \\
  -d '{"session":"g:<groupId>","title":"构建通过","content":"main 分支构建成功"}'`}
                        </code>
                        <code className={codeClass}>
                            {`curl -H "Authorization: Bearer <app_token>" "${origin}/open/messages?session=g:<groupId>&limit=20"`}
                        </code>
                    </div>
                </Panel>
            </>
        );
    };

    const SecurityPage = () => {
        const navigate = useNavigate();
        const jump = (id: string) => {
            document
                .getElementById(id)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
        };
        return (
            <PageShell
                title="安全与企业接入"
                subtitle="通知策略、设备管理、机器人与开放 API"
                onBack={() => void navigate(-1)}
                nav={
                    <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                        {[
                            { id: "dnd", label: "免打扰" },
                            { id: "devices", label: "设备与验证" },
                            { id: "apps", label: "机器人接入" },
                        ].map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                className="shrink-0 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
                                onClick={() => jump(item.id)}
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                }
            >
                <DndPanel />
                <DevicesPanel />
                <BotsPanel />
            </PageShell>
        );
    };

    const unregisterRoute = ui.registerRoute(
        "/settings/security",
        SecurityPage,
    );

    return () => {
        unregisterRoute();
    };
};
