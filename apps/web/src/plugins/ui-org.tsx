import type { Context } from "@plugim/core";
import { lazy } from "react";
import type { UiService } from "./ui-types";

export const uiOrgSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");

    const OrgPage = lazy(async () => {
        const module = await import("./ui-org-page");
        return { default: module.createOrgPage(ctx) };
    });

    return ui.registerRoute("/org", OrgPage);
};
