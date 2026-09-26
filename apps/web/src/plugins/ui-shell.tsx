import type { Context } from "@plugim/core";
import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { cn } from "../lib/utils";
import type { AuthService } from "./auth";
import type { FriendsService } from "./friends";
import type { GroupsService } from "./groups";
import type { InstallService } from "./ui-install";
import {
    displayName,
    isPopupWindow,
    openChat,
    useShellPane,
} from "./ui-shared";
import type { UiService } from "./ui-types";

export const uiShellSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const auth = ctx.get<AuthService>("auth");
    const install = ctx.get<InstallService>("install");
    const friends = ctx.get<FriendsService>("friends");
    const groups = ctx.get<GroupsService>("groups");

    const useInstallStatus = () =>
        useSyncExternalStore(
            (cb) => install.onChange(cb),
            () => install.status(),
        );

    const useAuthUser = () =>
        useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.user(),
        );

    const useAuthRestoring = () =>
        useSyncExternalStore(
            (cb) => auth.onChange(cb),
            () => auth.restoring(),
        );

    const RequireAuth = ({ children }: { children: ReactNode }) => {
        const user = useAuthUser();
        const restoring = useAuthRestoring();
        const location = useLocation();
        if (restoring && !user) return null;
        if (!user) {
            return (
                <Navigate
                    to="/login"
                    replace
                    state={{ from: location.pathname }}
                />
            );
        }
        return children;
    };

    const DetachedSession = ({ session }: { session: string }) => {
        useEffect(() => {
            const label = () => {
                if (session === "general") return "综合频道";
                if (session.startsWith("g:"))
                    return (
                        groups
                            .cached()
                            ?.find((group) => `g:${group.id}` === session)
                            ?.name ?? "群聊"
                    );
                if (session.startsWith("p2p:"))
                    return displayName(
                        session.slice(4),
                        friends.cached()?.remarks,
                    );
                return "会话";
            };
            document.title = label();
            openChat(ctx, { session, title: label() });
            const disposeFriends = friends.onUpdate(() => {
                document.title = label();
            });
            const disposeGroups = groups.onUpdate(() => {
                document.title = label();
            });
            return () => {
                void disposeFriends();
                void disposeGroups();
            };
        }, [session]);
        return null;
    };

    const ChatPage = () => {
        const pane = useShellPane();
        const popup = isPopupWindow();
        const detached = popup
            ? (new URLSearchParams(window.location.search).get("session") ??
              "general")
            : "";
        return (
            <RequireAuth>
                {popup ? <DetachedSession session={detached} /> : null}
                <div className="flex min-h-0 w-full flex-1">
                    {popup ? null : (
                        <aside
                            className={cn(
                                "w-full shrink-0 flex-col border-r border-border bg-background md:flex md:w-60",
                                pane === "chat" ? "hidden" : "flex",
                            )}
                        >
                            <ui.Slot
                                slot="sidebar"
                                className="flex min-h-0 flex-1 flex-col"
                            />
                        </aside>
                    )}
                    <div
                        className={cn(
                            "relative min-w-0 flex-1 flex-col",
                            pane === "chat" || popup
                                ? "flex"
                                : "hidden md:flex",
                        )}
                    >
                        <ui.Slot
                            slot="header"
                            className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-3 pt-[max(0.75rem,env(safe-area-inset-top))] md:px-4"
                        />
                        <ui.Slot
                            slot="messages"
                            className="flex min-h-0 flex-1 flex-col bg-chat-bg"
                        />
                        <ui.Slot
                            slot="composer"
                            className="shrink-0 border-t border-border bg-background p-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] md:p-3 md:pb-3"
                        />
                        <ui.Slot
                            slot="overlay"
                            className="pointer-events-none absolute inset-0 z-10"
                        />
                    </div>
                </div>
            </RequireAuth>
        );
    };

    const FriendsPage = () => {
        const pane = useShellPane();
        return (
            <RequireAuth>
                <div className="flex min-h-0 w-full flex-1">
                    <aside
                        className={cn(
                            "w-full shrink-0 flex-col border-r border-border bg-background md:flex md:w-60",
                            pane === "chat" ? "hidden" : "flex",
                        )}
                    >
                        <ui.Slot
                            slot="friends-list"
                            className="flex min-h-0 flex-1 flex-col"
                        />
                    </aside>
                    <div
                        className={cn(
                            "min-w-0 flex-1 flex-col",
                            pane === "chat" ? "flex" : "hidden md:flex",
                        )}
                    >
                        <ui.Slot
                            slot="friends-detail"
                            className="min-h-0 flex-1 overflow-y-auto"
                        />
                    </div>
                </div>
            </RequireAuth>
        );
    };

    const LoginPage = () => {
        const user = useAuthUser();
        const restoring = useAuthRestoring();
        const status = useInstallStatus();
        const from = useLocation().state as { from?: string } | null;
        if (restoring && !user) return null;
        if (user) return <Navigate to={from?.from ?? "/chat"} replace />;
        if (!status) return null;
        if (!status.installed) return <Navigate to="/install" replace />;
        return (
            <div className="flex h-full items-center justify-center p-4">
                <ui.Slot slot="auth" className="w-full max-w-sm" />
            </div>
        );
    };

    const unregisterChat = ui.registerRoute("/chat", ChatPage);
    const unregisterFriends = ui.registerRoute("/friends", FriendsPage);
    const unregisterLogin = ui.registerRoute("/login", LoginPage);
    return () => {
        unregisterChat();
        unregisterFriends();
        unregisterLogin();
    };
};
