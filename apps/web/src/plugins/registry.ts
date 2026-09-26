import type { Plugin } from "@plugim/core";
import { authPlugin } from "./auth";
import { cachePlugin } from "./cache";
import { connectionPlugin } from "./connection";
import { friendsPlugin } from "./friends";
import { groupsPlugin } from "./groups";
import { presencePlugin } from "./presence";
import { senderPlugin } from "./sender";
import { settingsPlugin } from "./settings";
import { uiViewsPlugin } from "./ui-views";

export const globalPlugins: Plugin[] = [
    authPlugin,
    settingsPlugin,
    connectionPlugin,
    senderPlugin,
    friendsPlugin,
    groupsPlugin,
    presencePlugin,
    cachePlugin,
    uiViewsPlugin,
];

export const DISABLED_PLUGINS_KEY = "plugim_disabled_plugins";

export const loadDisabledPlugins = (): string[] => {
    try {
        const raw = localStorage.getItem(DISABLED_PLUGINS_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string")
            : [];
    } catch {
        return [];
    }
};

export const saveDisabledPlugins = (names: string[]): void => {
    try {
        localStorage.setItem(DISABLED_PLUGINS_KEY, JSON.stringify(names));
    } catch {
        void 0;
    }
};
