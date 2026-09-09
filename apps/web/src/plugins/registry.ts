import type { Plugin } from "@plugim/core";
import { authPlugin } from "./auth";
import { connectionPlugin } from "./connection";
import { friendsPlugin } from "./friends";
import { senderPlugin } from "./sender";
import { shellPlugin } from "./shell";
import { uiAuthPlugin } from "./ui-auth";
import { uiComposerPlugin } from "./ui-composer";
import { uiFriendsPanelPlugin } from "./ui-friends-panel";
import { uiHeaderPlugin } from "./ui-header";
import { uiMessagesPlugin } from "./ui-messages";
import { uiPluginsPlugin } from "./ui-plugins";
import { uiSidebarPlugin } from "./ui-sidebar";

export const globalPlugins: Plugin[] = [
    authPlugin,
    connectionPlugin,
    senderPlugin,
    friendsPlugin,
    shellPlugin,
    uiAuthPlugin,
    uiSidebarPlugin,
    uiHeaderPlugin,
    uiMessagesPlugin,
    uiComposerPlugin,
    uiFriendsPanelPlugin,
    uiPluginsPlugin,
];

export const DISABLED_PLUGINS_KEY = "plugim_disabled_plugins";

export const loadDisabledPlugins = (): string[] => {
    try {
        const raw = localStorage.getItem(DISABLED_PLUGINS_KEY);
        const parsed = raw ? (JSON.parse(raw) as unknown) : [];
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
