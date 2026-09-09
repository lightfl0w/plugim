import type { Plugin } from "@plugim/core";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { AuthService } from "./auth";
import type { UiService } from "./ui";

export const shellPlugin: Plugin = {
    name: "shell",
    description: "主界面布局与页面路由",
    inject: ["ui", "auth"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");

        const useAuthUser = () =>
            useSyncExternalStore(
                (cb) => auth.onChange(cb),
                () => auth.user(),
            );

        const RequireAuth = ({ children }: { children: ReactNode }) => {
            const user = useAuthUser();
            const location = useLocation();
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

        const ChatPage = () => (
            <RequireAuth>
                <div className="flex min-h-0 w-full flex-1">
                    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
                        <ui.Slot
                            slot="sidebar"
                            className="flex min-h-0 flex-1 flex-col"
                        />
                    </aside>
                    <div className="relative flex min-w-0 flex-1 flex-col">
                        <ui.Slot
                            slot="header"
                            className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3"
                        />
                        <ui.Slot
                            slot="messages"
                            className="flex min-h-0 flex-1 flex-col"
                        />
                        <ui.Slot
                            slot="composer"
                            className="shrink-0 border-t border-border p-3"
                        />
                        <ui.Slot
                            slot="overlay"
                            className="pointer-events-none absolute inset-0 z-10"
                        />
                    </div>
                </div>
            </RequireAuth>
        );

        const FriendsPage = () => (
            <RequireAuth>
                <div className="flex min-h-0 w-full flex-1">
                    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-background">
                        <ui.Slot
                            slot="friends-list"
                            className="flex min-h-0 flex-1 flex-col"
                        />
                    </aside>
                    <div className="flex min-w-0 flex-1 flex-col">
                        <ui.Slot
                            slot="friends-detail"
                            className="min-h-0 flex-1 overflow-y-auto"
                        />
                    </div>
                </div>
            </RequireAuth>
        );

        const LoginPage = () => {
            const user = useAuthUser();
            const from = useLocation().state as { from?: string } | null;
            if (user) return <Navigate to={from?.from ?? "/chat"} replace />;
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
    },
};
