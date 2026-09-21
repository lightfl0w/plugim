import type { Plugin } from "@plugim/core";
import { authPlugin } from "./auth";
import { cachePlugin } from "./cache";
import { connectionPlugin } from "./connection";
import { friendsPlugin } from "./friends";
import { groupsPlugin } from "./groups";
import { presencePlugin } from "./presence";
import { senderPlugin } from "./sender";
import { shellPlugin } from "./shell";
import { themePlugin } from "./theme";
import { uiAdminPlugin } from "./ui-admin";
import { uiAuthPlugin } from "./ui-auth";
import { uiComposerPlugin } from "./ui-composer";
import { uiFriendsPanelPlugin } from "./ui-friends-panel";
import { uiGroupPanelPlugin } from "./ui-group-panel";
import { uiHeaderPlugin } from "./ui-header";
import { uiMediaViewerPlugin } from "./ui-mediaviewer";
import { uiMessagesPlugin } from "./ui-messages";
import { uiProfilePlugin } from "./ui-profile";
import { uiProfileCardPlugin } from "./ui-profilecard";
import { uiSidebarPlugin } from "./ui-sidebar";

export const globalPlugins: Plugin[] = [
    authPlugin,
    themePlugin,
    connectionPlugin,
    senderPlugin,
    friendsPlugin,
    groupsPlugin,
    presencePlugin,
    cachePlugin,
    shellPlugin,
    uiAuthPlugin,
    uiSidebarPlugin,
    uiHeaderPlugin,
    uiMessagesPlugin,
    uiComposerPlugin,
    uiFriendsPanelPlugin,
    uiProfilePlugin,
    uiProfileCardPlugin,
    uiMediaViewerPlugin,
    uiGroupPanelPlugin,
    uiAdminPlugin,
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
