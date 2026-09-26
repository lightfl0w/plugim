import type { Context } from "@plugim/core";

export type ThemeMode = "light" | "dark" | "system";

export interface ThemeService {
    mode(): ThemeMode;
    setMode(mode: ThemeMode): void;
    onChange(cb: () => void): () => void;
}

const THEME_KEY = "plugim_theme";
const MODES: ThemeMode[] = ["light", "dark", "system"];

export const themeSetup = async (ctx: Context) => {
    const saved = localStorage.getItem(THEME_KEY);
    let current: ThemeMode = MODES.includes(saved as ThemeMode)
        ? (saved as ThemeMode)
        : "system";
    const listeners = new Set<() => void>();
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const apply = () => {
        const dark =
            current === "dark" || (current === "system" && media.matches);
        document.documentElement.classList.toggle("dark", dark);
    };
    const notify = () => {
        for (const cb of listeners) cb();
    };

    const onMedia = () => {
        if (current === "system") apply();
    };
    media.addEventListener("change", onMedia);
    apply();

    ctx.provide<ThemeService>("theme", {
        mode: () => current,
        setMode(mode) {
            current = mode;
            localStorage.setItem(THEME_KEY, mode);
            apply();
            notify();
        },
        onChange(cb) {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
    });

    return () => {
        media.removeEventListener("change", onMedia);
    };
};
