import type { Plugin } from "@plugim/core";
import type { FC } from "react";
import { useEffect, useReducer } from "react";
import { createRoot } from "react-dom/client";
import type { AuthService } from "./auth";

export type UiSlot =
    | "auth"
    | "sidebar"
    | "header"
    | "messages"
    | "composer"
    | "overlay";

export interface UiService {
    register(slot: UiSlot, component: FC, order?: number): () => void;
}

interface Entry {
    id: number;
    component: FC;
    order: number;
}

const bumpReducer = (count: number) => count + 1;

export const shellPlugin: Plugin = {
    name: "shell",
    inject: ["auth"],
    async apply(ctx) {
        const auth = ctx.get<AuthService>("auth");
        const registry = new Map<UiSlot, Entry[]>();
        const listeners = new Set<() => void>();
        let seq = 0;

        const notify = () => {
            for (const cb of listeners) cb();
        };

        ctx.provide<UiService>("ui", {
            register(slot, component, order = 0) {
                const id = ++seq;
                const list = registry.get(slot) ?? [];
                list.push({ id, component, order });
                list.sort((a, b) => a.order - b.order);
                registry.set(slot, list);
                notify();
                return () => {
                    registry.set(
                        slot,
                        (registry.get(slot) ?? []).filter(
                            (entry) => entry.id !== id,
                        ),
                    );
                    notify();
                };
            },
        });

        const subscribe = (cb: () => void) => {
            listeners.add(cb);
            return () => listeners.delete(cb);
        };

        const Slot = ({
            slot,
            className,
        }: {
            slot: UiSlot;
            className?: string;
        }) => {
            const [, bump] = useReducer(bumpReducer, 0);
            useEffect(() => {
                const un = subscribe(bump);
                return () => {
                    un();
                };
            }, []);
            const items = registry.get(slot) ?? [];
            return (
                <div className={className}>
                    {items.map(({ id, component: Item }) => (
                        <Item key={id} />
                    ))}
                </div>
            );
        };

        const Shell = () => {
            const [, bump] = useReducer(bumpReducer, 0);
            useEffect(() => {
                const unRegistry = subscribe(bump);
                const unAuth = auth.onChange(bump);
                return () => {
                    unRegistry();
                    unAuth();
                };
            }, []);
            if (!auth.user()) {
                return (
                    <div className="flex h-full items-center justify-center p-4">
                        <Slot slot="auth" className="w-full max-w-sm" />
                    </div>
                );
            }
            return (
                <div className="relative flex h-full">
                    <div className="flex w-64 shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground">
                        <Slot
                            slot="sidebar"
                            className="flex min-h-0 flex-1 flex-col"
                        />
                    </div>
                    <div className="relative flex min-w-0 flex-1 flex-col">
                        <Slot
                            slot="header"
                            className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5"
                        />
                        <Slot
                            slot="messages"
                            className="min-h-0 flex-1 overflow-y-auto p-4"
                        />
                        <Slot
                            slot="composer"
                            className="shrink-0 border-t border-border bg-background p-3"
                        />
                        <Slot
                            slot="overlay"
                            className="pointer-events-none absolute inset-0 z-10"
                        />
                    </div>
                </div>
            );
        };

        const root = document.getElementById("root");
        if (!root) throw new Error("missing #root element");
        createRoot(root).render(<Shell />);
        return undefined;
    },
};
