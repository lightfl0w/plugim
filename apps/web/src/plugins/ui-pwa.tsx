import type { Context } from "@plugim/core";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import type { UiService } from "./ui-types";

const PENDING_KEY = "plugim:push-open";

export const uiPwaSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");

    if (!import.meta.env.DEV && "serviceWorker" in navigator) {
        void navigator.serviceWorker
            .register("/sw.js")
            .catch((err) =>
                ctx.log.warn("service worker register failed", err),
            );
    }

    const params = new URLSearchParams(window.location.search);
    const coldSession = params.get("open");
    if (coldSession) {
        params.delete("open");
        const query = params.toString();
        window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
        );
        sessionStorage.setItem(PENDING_KEY, coldSession);
    }

    const consumePending = () => {
        const session = sessionStorage.getItem(PENDING_KEY);
        if (!session) return null;
        sessionStorage.removeItem(PENDING_KEY);
        return session;
    };

    const onServiceWorkerMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; session?: string };
        if (data?.type !== "push:open") return;
        const session = data.session ?? "";
        if (!session) return;
        if (window.location.pathname === "/chat") {
            ctx.emit("ui:chat:open", { session, title: session });
            return;
        }
        sessionStorage.setItem(PENDING_KEY, session);
        window.location.assign("/chat");
    };
    navigator.serviceWorker?.addEventListener(
        "message",
        onServiceWorkerMessage,
    );

    const Bridge = () => {
        const navigate = useNavigate();
        useEffect(() => {
            const open = (session: string) => {
                ctx.emit("ui:chat:open", { session, title: session });
                void navigate("/chat");
            };
            const flush = () => {
                const session = consumePending();
                if (session) open(session);
            };
            const disposeEvent = ctx.on("ui:chat:open", flush);
            const timer = window.setTimeout(flush, 400);
            return () => {
                window.clearTimeout(timer);
                void disposeEvent();
            };
        }, [navigate]);
        return null;
    };

    const unregister = ui.register("overlay", Bridge, 5);
    return () => {
        navigator.serviceWorker?.removeEventListener(
            "message",
            onServiceWorkerMessage,
        );
        unregister();
    };
};
