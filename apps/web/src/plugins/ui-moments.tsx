import type { Context } from "@plugim/core";
import { lazy, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { MomentsService } from "./moments";
import type { UiService } from "./ui-types";

export const uiMomentsSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const moments = ctx.get<MomentsService>("moments");

    const MomentsAlerts = () => {
        const navigate = useNavigate();
        useEffect(() => {
            const disposeOpen = ctx.on("ui:moments:open", (payload) => {
                const author = (payload as { author?: string } | null)?.author;
                if (author) moments.setAuthor(author);
                void navigate("/moments");
            });
            return () => {
                void disposeOpen();
            };
        }, [navigate]);
        return null;
    };

    const MomentsPage = lazy(async () => {
        const module = await import("./ui-moments-page");
        return { default: module.createMomentsPage(ctx) };
    });

    const unregisterRoute = ui.registerRoute("/moments", MomentsPage);
    const unregisterAlerts = ui.register("overlay", MomentsAlerts, 15);
    return () => {
        unregisterRoute();
        unregisterAlerts();
    };
};
