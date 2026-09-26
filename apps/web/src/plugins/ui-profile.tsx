import type { Context } from "@plugim/core";
import {
    ArrowLeftIcon,
    BellIcon,
    ChevronRightIcon,
    KeyRoundIcon,
    LogOutIcon,
    MonitorIcon,
    MoonIcon,
    PaletteIcon,
    SendIcon,
    SmartphoneIcon,
    SunIcon,
    VolumeIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import {
    Field,
    FieldError,
    FieldGroup,
    FieldLabel,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { RpcService } from "./connection";
import type { FriendsService } from "./friends";
import type { ThemeMode, ThemeService } from "./theme";
import type { AdminService } from "./ui-admin";
import { isSoundEnabled, setSoundEnabled } from "./ui-shared";
import type { UiService } from "./ui-types";

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: ReactNode }[] = [
    { value: "light", label: "浅色", icon: <SunIcon className="size-4" /> },
    { value: "dark", label: "深色", icon: <MoonIcon className="size-4" /> },
    {
        value: "system",
        label: "跟随系统",
        icon: <MonitorIcon className="size-4" />,
    },
];

const THEME_ORDER: ThemeMode[] = ["light", "dark", "system"];

const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const readyRegistration =
    async (): Promise<ServiceWorkerRegistration | null> => {
        if (!("serviceWorker" in navigator)) return null;
        const timeout = new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), 2000);
        });
        return Promise.race([navigator.serviceWorker.ready, timeout]);
    };

const decodeKey = (base64: string) => {
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return bytes;
};

const withTimeout = <T,>(promise: Promise<T>, ms: number, message: string) =>
    Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            window.setTimeout(() => reject(new Error(message)), ms);
        }),
    ]);

export const uiProfileSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const theme = ctx.get<ThemeService>("theme");
    const friends = ctx.get<FriendsService>("friends");
    const admin = ctx.get<AdminService>("admin");
    const rpc = ctx.get<RpcService>("rpc");

    const useUser = () =>
        useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.user(),
        );
    const useIsAdmin = () =>
        useSyncExternalStore(
            (cb) => admin.onChange(cb),
            () => admin.is(),
        );
    const useRestoring = () =>
        useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.restoring(),
        );
    const useThemeMode = () =>
        useSyncExternalStore(
            (cb) => theme.onChange(cb),
            () => theme.mode(),
        );
    const useFriendCount = () =>
        useSyncExternalStore(
            (cb) => friends.onUpdate(cb),
            () => friends.cached()?.friends.length ?? 0,
        );

    const section = "rounded-xl border border-border bg-card";
    const rowClass = "flex items-center gap-3 px-4 py-3.5";

    const ThemeRailButton = () => {
        const mode = useThemeMode();
        const next =
            THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
        const Icon =
            mode === "dark"
                ? MoonIcon
                : mode === "light"
                  ? SunIcon
                  : MonitorIcon;
        return (
            <button
                type="button"
                title={`外观：${
                    THEME_OPTIONS.find((o) => o.value === mode)?.label ?? ""
                }（点击切换）`}
                onClick={() => theme.setMode(next)}
                className="mt-2 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
                <Icon className="size-5" />
            </button>
        );
    };

    const PasswordSection = () => {
        const [open, setOpen] = useState(false);
        const [oldPassword, setOldPassword] = useState("");
        const [newPassword, setNewPassword] = useState("");
        const [confirm, setConfirm] = useState("");
        const [busy, setBusy] = useState(false);
        const [hint, setHint] = useState<{ bad: boolean; text: string } | null>(
            null,
        );

        const submit = async () => {
            if (busy) return;
            if (newPassword.length < 6) {
                setHint({ bad: true, text: "新密码至少需要 6 位" });
                return;
            }
            if (newPassword !== confirm) {
                setHint({ bad: true, text: "两次输入的新密码不一致" });
                return;
            }
            setBusy(true);
            setHint(null);
            try {
                const result = (await rpc.call("auth.password", {
                    oldPassword,
                    newPassword,
                })) as { token: string };
                auth.setToken(result.token);
                setOldPassword("");
                setNewPassword("");
                setConfirm("");
                setHint({ bad: false, text: "密码已更新，其他设备已下线" });
            } catch (err) {
                setHint({
                    bad: true,
                    text: String(err instanceof Error ? err.message : err),
                });
            } finally {
                setBusy(false);
            }
        };

        return (
            <section className={section}>
                <button
                    type="button"
                    className={cn(
                        rowClass,
                        "w-full text-left hover:bg-accent/60",
                    )}
                    onClick={() => setOpen((prev) => !prev)}
                >
                    <KeyRoundIcon className="size-4 text-muted-foreground" />
                    <p className="flex-1 text-sm">修改密码</p>
                    <ChevronRightIcon
                        className={cn(
                            "size-4 text-muted-foreground transition-transform",
                            open && "rotate-90",
                        )}
                    />
                </button>
                {open ? (
                    <form
                        className="border-t border-border p-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            void submit();
                        }}
                    >
                        <FieldGroup>
                            <Field>
                                <FieldLabel htmlFor="pwd-old">
                                    当前密码
                                </FieldLabel>
                                <Input
                                    id="pwd-old"
                                    type="password"
                                    autoComplete="current-password"
                                    value={oldPassword}
                                    onChange={(event) =>
                                        setOldPassword(event.target.value)
                                    }
                                />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="pwd-new">
                                    新密码
                                </FieldLabel>
                                <Input
                                    id="pwd-new"
                                    type="password"
                                    placeholder="至少 6 位"
                                    autoComplete="new-password"
                                    value={newPassword}
                                    onChange={(event) =>
                                        setNewPassword(event.target.value)
                                    }
                                />
                            </Field>
                            <Field>
                                <FieldLabel htmlFor="pwd-confirm">
                                    确认新密码
                                </FieldLabel>
                                <Input
                                    id="pwd-confirm"
                                    type="password"
                                    autoComplete="new-password"
                                    value={confirm}
                                    onChange={(event) =>
                                        setConfirm(event.target.value)
                                    }
                                />
                            </Field>
                            {hint ? (
                                <FieldError
                                    className={cn(!hint.bad && "text-primary")}
                                >
                                    {hint.text}
                                </FieldError>
                            ) : null}
                            <Button
                                type="submit"
                                variant="outline"
                                disabled={
                                    busy ||
                                    !oldPassword ||
                                    newPassword.length < 6 ||
                                    !confirm
                                }
                            >
                                更新密码
                            </Button>
                        </FieldGroup>
                    </form>
                ) : null}
            </section>
        );
    };

    const ProfilePage = () => {
        const user = useUser();
        const isAdmin = useIsAdmin();
        const restoring = useRestoring();
        const mode = useThemeMode();
        const friendCount = useFriendCount();
        const navigate = useNavigate();
        const [permission, setPermission] = useState<NotificationPermission>(
            typeof Notification === "undefined"
                ? "denied"
                : Notification.permission,
        );
        const [soundOn, setSoundOn] = useState(() =>
            isSoundEnabled(user?.username ?? ""),
        );
        const [pushState, setPushState] = useState<
            "checking" | "unsupported" | "off" | "on"
        >("checking");
        const [pushBusy, setPushBusy] = useState(false);
        useEffect(() => {
            let cancelled = false;
            const check = async () => {
                const registration = await readyRegistration();
                if (cancelled) return;
                if (!registration?.pushManager) {
                    setPushState("unsupported");
                    return;
                }
                const subscription = await withTimeout(
                    registration.pushManager.getSubscription(),
                    5000,
                    "读取订阅状态超时",
                );
                if (!cancelled) setPushState(subscription ? "on" : "off");
            };
            void check().catch(() => {
                if (!cancelled) setPushState("unsupported");
            });
            return () => {
                cancelled = true;
            };
        }, []);
        useEffect(() => {
            setSoundOn(isSoundEnabled(user?.username ?? ""));
        }, [user?.username]);

        if (restoring && !user) return null;
        if (!user) return <Navigate to="/login" replace />;

        const requestNotify = () => {
            if (typeof Notification === "undefined") return;
            void Notification.requestPermission().then((next) => {
                if (next !== "default") setPermission(next);
            });
        };

        const togglePush = async () => {
            setPushBusy(true);
            try {
                const registration = await readyRegistration();
                if (!registration?.pushManager) {
                    setPushState("unsupported");
                    return;
                }
                const current = await withTimeout(
                    registration.pushManager.getSubscription(),
                    5000,
                    "读取订阅状态超时",
                );
                if (current) {
                    await rpc.call("push.unsubscribe", {
                        endpoint: current.endpoint,
                    });
                    await withTimeout(current.unsubscribe(), 5000, "退订超时");
                    setPushState("off");
                    return;
                }
                const info = (await rpc.call("push.info", {})) as {
                    publicKey: string;
                };
                const created = await withTimeout(
                    registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: decodeKey(info.publicKey),
                    }),
                    15000,
                    "订阅超时，浏览器推送服务不可用",
                );
                await rpc.call("push.subscribe", {
                    subscription: created.toJSON(),
                });
                setPushState("on");
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            } finally {
                setPushBusy(false);
            }
        };

        const testPush = async () => {
            try {
                await rpc.call("push.test", {});
                alert("测试通知已发送");
            } catch (err) {
                alert(String(err instanceof Error ? err.message : err));
            }
        };

        const pushHint =
            pushState === "unsupported"
                ? "当前环境不支持（需在 HTTPS 或本地正式构建中开启）"
                : pushState === "on"
                  ? "关闭页面后仍可收到新消息通知"
                  : "开启后可在离线时收到系统通知";

        const notifyHint =
            permission === "granted"
                ? "如需关闭请在系统设置中操作"
                : permission === "denied"
                  ? "浏览器已阻止通知"
                  : "开启后可在后台接收新消息提醒";

        return (
            <div className="flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        title="返回"
                        onClick={() => void navigate(-1)}
                    >
                        <ArrowLeftIcon />
                    </Button>
                    <p className="text-sm font-semibold">用户中心</p>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
                        <section className={cn(section, "overflow-hidden")}>
                            <div className="h-20 bg-primary/10" />
                            <div className="-mt-8 flex items-end gap-3 px-4 pb-4">
                                <span className="rounded-full ring-4 ring-card">
                                    <UserAvatar
                                        name={user.username}
                                        size="lg"
                                    />
                                </span>
                                <div className="min-w-0 flex-1 pb-0.5">
                                    <p className="truncate text-base font-semibold">
                                        {user.username}
                                    </p>
                                    <p className="truncate text-xs text-muted-foreground">
                                        ID: {user.id.slice(0, 8)}
                                    </p>
                                </div>
                            </div>
                            <div className="flex gap-6 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
                                <span>注册于 {formatDate(user.createdAt)}</span>
                                <span>好友 {friendCount} 位</span>
                            </div>
                        </section>

                        <section className={section}>
                            <div
                                className={cn(
                                    rowClass,
                                    "border-b border-border",
                                )}
                            >
                                <PaletteIcon className="size-4 text-muted-foreground" />
                                <p className="flex-1 text-sm">主题外观</p>
                            </div>
                            <div className="flex gap-2 p-3">
                                {THEME_OPTIONS.map((option) => (
                                    <button
                                        key={option.value}
                                        type="button"
                                        onClick={() =>
                                            theme.setMode(option.value)
                                        }
                                        className={cn(
                                            "flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                                            mode === option.value
                                                ? "border-primary bg-primary/10 text-primary font-medium"
                                                : "border-border text-muted-foreground hover:bg-accent/60",
                                        )}
                                    >
                                        {option.icon}
                                        {option.label}
                                    </button>
                                ))}
                            </div>
                        </section>

                        <section className={section}>
                            <div
                                className={cn(
                                    rowClass,
                                    "border-b border-border",
                                )}
                            >
                                <BellIcon className="size-4 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm">桌面通知</p>
                                    <p className="text-xs text-muted-foreground">
                                        {notifyHint}
                                    </p>
                                </div>
                                <Switch
                                    checked={permission === "granted"}
                                    disabled={
                                        permission !== "default" ||
                                        typeof Notification === "undefined"
                                    }
                                    onToggle={requestNotify}
                                />
                            </div>
                            <div
                                className={cn(
                                    rowClass,
                                    "border-b border-border",
                                )}
                            >
                                <VolumeIcon className="size-4 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm">新消息提示音</p>
                                    <p className="text-xs text-muted-foreground">
                                        收到消息时播放短促提示音
                                    </p>
                                </div>
                                <Switch
                                    checked={soundOn}
                                    onToggle={() => {
                                        setSoundOn((prev) => {
                                            setSoundEnabled(
                                                user.username,
                                                !prev,
                                            );
                                            return !prev;
                                        });
                                    }}
                                />
                            </div>
                            <div
                                className={cn(
                                    rowClass,
                                    "border-b border-border",
                                )}
                            >
                                <SmartphoneIcon className="size-4 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm">离线消息推送</p>
                                    <p className="text-xs text-muted-foreground">
                                        {pushHint}
                                    </p>
                                </div>
                                {pushState === "on" ? (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => void testPush()}
                                    >
                                        <SendIcon />
                                        测试
                                    </Button>
                                ) : null}
                                <Switch
                                    checked={pushState === "on"}
                                    disabled={
                                        pushBusy ||
                                        pushState === "checking" ||
                                        pushState === "unsupported"
                                    }
                                    onToggle={() => void togglePush()}
                                />
                            </div>
                            <button
                                type="button"
                                className={cn(
                                    rowClass,
                                    "w-full text-left hover:bg-accent/60",
                                )}
                                onClick={() =>
                                    void navigate("/settings/plugins")
                                }
                            >
                                <p className="flex-1 text-sm">插件管理</p>
                                <ChevronRightIcon className="size-4 text-muted-foreground" />
                            </button>
                            {isAdmin ? (
                                <button
                                    type="button"
                                    className={cn(
                                        rowClass,
                                        "w-full border-t border-border text-left hover:bg-accent/60",
                                    )}
                                    onClick={() => void navigate("/admin")}
                                >
                                    <p className="flex-1 text-sm">后台管理</p>
                                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                                </button>
                            ) : null}
                        </section>

                        <PasswordSection />

                        <section className={section}>
                            <div className={cn(rowClass, "gap-2")}>
                                <Button
                                    variant="destructive"
                                    className="w-full"
                                    onClick={() => {
                                        auth.logout();
                                        void navigate("/login");
                                    }}
                                >
                                    <LogOutIcon />
                                    退出登录
                                </Button>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        );
    };

    const unregisterRoute = ui.registerRoute("/me", ProfilePage);
    const unregisterRail = ui.register("nav", ThemeRailButton, 90);
    return () => {
        unregisterRoute();
        unregisterRail();
    };
};
