import type { Plugin } from "@plugim/core";
import {
    ArrowLeftIcon,
    BellIcon,
    ChevronRightIcon,
    LogOutIcon,
    MonitorIcon,
    MoonIcon,
    PaletteIcon,
    SunIcon,
    VolumeIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { UserAvatar } from "../components/ui/user-avatar";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { FriendsService } from "./friends";
import type { ThemeMode, ThemeService } from "./theme";
import type { UiService } from "./ui";
import { isSoundEnabled, setSoundEnabled } from "./ui-sidebar";

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: ReactNode }[] = [
    { value: "light", label: "浅色", icon: <SunIcon className="size-4" /> },
    { value: "dark", label: "深色", icon: <MoonIcon className="size-4" /> },
    {
        value: "system",
        label: "跟随系统",
        icon: <MonitorIcon className="size-4" />,
    },
];

const formatDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const uiProfilePlugin: Plugin = {
    name: "ui-profile",
    description: "用户中心(资料 / 外观 / 通知 / 账号)",
    inject: ["ui", "auth", "theme", "friends"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const theme = ctx.get<ThemeService>("theme");
        const friends = ctx.get<FriendsService>("friends");

        const useUser = () =>
            useSyncExternalStore(
                (cb) => auth.onChange(cb),
                () => auth.user(),
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

        const ProfilePage = () => {
            const user = useUser();
            const restoring = useRestoring();
            const mode = useThemeMode();
            const friendCount = useFriendCount();
            const navigate = useNavigate();
            const [permission, setPermission] =
                useState<NotificationPermission>(
                    typeof Notification === "undefined"
                        ? "denied"
                        : Notification.permission,
                );
            const [soundOn, setSoundOn] = useState(() =>
                isSoundEnabled(user?.username ?? ""),
            );
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
                                <div className="h-20 bg-gradient-to-r from-primary/70 to-primary/30" />
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
                                    <span>
                                        注册于 {formatDate(user.createdAt)}
                                    </span>
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
                            </section>

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

        return ui.registerRoute("/me", ProfilePage);
    },
};
