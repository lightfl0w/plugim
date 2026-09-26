import type { Context, Dispose, Plugin } from "@plugim/core";
import { themeSetup } from "./theme";
import { uiAdminSetup } from "./ui-admin";
import { uiAuthSetup } from "./ui-auth";
import { uiCallSetup } from "./ui-call";
import { uiComposerSetup } from "./ui-composer";
import { uiFriendsPanelSetup } from "./ui-friends-panel";
import { uiGroupPanelSetup } from "./ui-group-panel";
import { uiHeaderSetup } from "./ui-header";
import { uiInstallSetup } from "./ui-install";
import { uiMediaViewerSetup } from "./ui-mediaviewer";
import { uiMessagesSetup } from "./ui-messages";
import { uiProfileSetup } from "./ui-profile";
import { uiProfileCardSetup } from "./ui-profilecard";
import { uiScreenSetup } from "./ui-screen";
import { uiSettingsSetup } from "./ui-settings";
import { uiShellSetup } from "./ui-shell";
import { uiSidebarSetup } from "./ui-sidebar";

type UiSetup = (ctx: Context) => Promise<Dispose | undefined>;

const SECTIONS: { name: string; setup: UiSetup }[] = [
    { name: "主题外观", setup: themeSetup },
    { name: "安装向导", setup: uiInstallSetup },
    { name: "后台管理", setup: uiAdminSetup },
    { name: "设置中心", setup: uiSettingsSetup },
    { name: "登录注册", setup: uiAuthSetup },
    { name: "主界面布局", setup: uiShellSetup },
    { name: "会话列表", setup: uiSidebarSetup },
    { name: "顶部栏", setup: uiHeaderSetup },
    { name: "消息流", setup: uiMessagesSetup },
    { name: "输入区", setup: uiComposerSetup },
    { name: "用户中心", setup: uiProfileSetup },
    { name: "媒体预览", setup: uiMediaViewerSetup },
    { name: "资料卡", setup: uiProfileCardSetup },
    { name: "好友面板", setup: uiFriendsPanelSetup },
    { name: "群面板", setup: uiGroupPanelSetup },
    { name: "屏幕共享", setup: uiScreenSetup },
    { name: "语音视频通话", setup: uiCallSetup },
];

export const uiViewsPlugin: Plugin = {
    name: "views",
    description: "全部界面",
    provides: ["theme", "admin"],
    inject: [
        "ui",
        "settings",
        "auth",
        "rpc",
        "sender",
        "cache",
        "friends",
        "groups",
        "presence",
    ],
    async apply(ctx) {
        const disposers: Dispose[] = [];
        for (const section of SECTIONS) {
            try {
                const dispose = await section.setup(ctx);
                if (dispose) disposers.push(dispose);
            } catch (err) {
                ctx.log.error(`ui section failed: ${section.name}`, err);
            }
        }
        return () => {
            for (const dispose of disposers.reverse()) {
                try {
                    dispose();
                } catch (err) {
                    ctx.log.error("ui section dispose failed", err);
                }
            }
        };
    },
};
