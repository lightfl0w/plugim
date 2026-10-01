import type { Context } from "@plugim/core";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { lazy, useSyncExternalStore } from "react";
import type { ThemeMode, ThemeService } from "./theme";
import type { UiService } from "./ui-types";

const THEME_ORDER: ThemeMode[] = ["light", "dark", "system"];

const THEME_LABELS: Record<ThemeMode, string> = {
    light: "浅色",
    dark: "深色",
    system: "跟随系统",
};

export const uiProfileSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const theme = ctx.get<ThemeService>("theme");

    const ThemeRailButton = () => {
        const mode = useSyncExternalStore(
            (cb) => theme.onChange(cb),
            () => theme.mode(),
        );
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
                title={`外观：${THEME_LABELS[mode]}（点击切换）`}
                onClick={() => theme.setMode(next)}
                className="mt-2 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
                <Icon className="size-5" />
            </button>
        );
    };

    const ProfilePage = lazy(async () => {
        const module = await import("./ui-profile-page");
        return { default: module.createProfilePage(ctx) };
    });

    const unregisterRoute = ui.registerRoute("/me", ProfilePage);
    const unregisterRail = ui.register("nav", ThemeRailButton, 90);
    return () => {
        unregisterRoute();
        unregisterRail();
    };
};
