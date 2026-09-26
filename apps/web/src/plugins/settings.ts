import type { Plugin } from "@plugim/core";

export type SettingsValue = string | number | boolean;

export interface SettingsField {
    key: string;
    label: string;
    kind: "color" | "number" | "boolean" | "select";
    default: SettingsValue;
    min?: number;
    max?: number;
    step?: number;
    options?: { value: string; label: string }[];
}

export interface SettingsGroup {
    plugin: string;
    title: string;
    fields: SettingsField[];
}

export interface SettingsService {
    groups(): SettingsGroup[];
    define(plugin: string, title: string, fields: SettingsField[]): void;
    get(plugin: string, key: string): SettingsValue;
    set(plugin: string, key: string, value: SettingsValue): void;
    reset(plugin: string, key: string): void;
    resetPlugin(plugin: string): void;
    isDefault(plugin: string, key: string): boolean;
    onChange(plugin: string, cb: () => void): () => void;
}

const STORE_KEY = "plugim_plugin_settings";

const loadStore = (): Record<string, Record<string, SettingsValue>> => {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        return typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, Record<string, SettingsValue>>)
            : {};
    } catch {
        return {};
    }
};

const persist = (store: Record<string, Record<string, SettingsValue>>) => {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch {
        void 0;
    }
};

export const settingsPlugin: Plugin = {
    name: "settings",
    description: "插件设置",
    provides: ["settings"],
    async apply(ctx) {
        const store = loadStore();
        const groups: SettingsGroup[] = [];
        const listeners = new Map<string, Set<() => void>>();

        const notify = (plugin: string) => {
            for (const cb of listeners.get(plugin) ?? []) cb();
            if (plugin !== "*") {
                for (const cb of listeners.get("*") ?? []) cb();
            }
        };
        const find = (plugin: string): SettingsGroup | undefined =>
            groups.find((g) => g.plugin === plugin);
        const fieldOf = (
            plugin: string,
            key: string,
        ): SettingsField | undefined =>
            find(plugin)?.fields.find((f) => f.key === key);

        ctx.provide<SettingsService>("settings", {
            groups: () => groups,
            define(plugin, title, fields) {
                const existing = find(plugin);
                const merged = [...fields];
                if (existing) {
                    for (const field of existing.fields) {
                        if (!merged.some((f) => f.key === field.key)) {
                            merged.push(field);
                        }
                    }
                }
                const group = { plugin, title, fields: merged };
                const index = groups.findIndex((g) => g.plugin === plugin);
                if (index >= 0) groups.splice(index, 1, group);
                else groups.push(group);
                notify(plugin);
            },
            get(plugin, key) {
                const stored = store[plugin]?.[key];
                if (stored !== undefined) return stored;
                return fieldOf(plugin, key)?.default ?? "";
            },
            set(plugin, key, value) {
                const scope = store[plugin] ?? {};
                scope[key] = value;
                store[plugin] = scope;
                persist(store);
                notify(plugin);
            },
            reset(plugin, key) {
                if (store[plugin]) delete store[plugin][key];
                persist(store);
                notify(plugin);
            },
            resetPlugin(plugin) {
                delete store[plugin];
                persist(store);
                notify(plugin);
            },
            isDefault(plugin, key) {
                return this.get(plugin, key) === fieldOf(plugin, key)?.default;
            },
            onChange(plugin, cb) {
                const set_ = listeners.get(plugin) ?? new Set();
                set_.add(cb);
                listeners.set(plugin, set_);
                return () => {
                    set_.delete(cb);
                };
            },
        });
    },
};
