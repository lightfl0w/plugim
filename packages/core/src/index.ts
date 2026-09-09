export type Dispose = () => void | Promise<void>;

export interface Logger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

export const defaultLogger: Logger = {
    info: (...args) => console.log("[core]", ...args),
    warn: (...args) => console.warn("[core]", ...args),
    error: (...args) => console.error("[core]", ...args),
};

export interface Plugin {
    name: string;
    description?: string;
    core?: boolean;
    provides?: string[];
    inject?: string[];
    apply(ctx: Context): Promise<Dispose | undefined>;
}

export type PluginState =
    | "enabled"
    | "disabled"
    | "started"
    | "failed"
    | "stopped";

export interface PluginInfo {
    name: string;
    description?: string;
    core: boolean;
    provides: string[];
    inject: string[];
    state: PluginState;
}

export interface ContextOptions {
    log?: Logger;
    disabled?: string[];
}

export class ServiceNotFoundError extends Error {
    constructor(public readonly name: string) {
        super(`service not found: ${name}`);
    }
}

type EventFn = (payload: unknown) => void;
type ChangeFn = () => void;

interface ServiceWaiter {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

interface PluginEntry {
    plugin: Plugin;
    state: PluginState;
    dispose?: Dispose;
}

export class Context {
    readonly log: Logger;
    private services = new Map<string, unknown>();
    private waiters = new Map<string, ServiceWaiter[]>();
    private unavailable = new Set<string>();
    private entries: PluginEntry[] = [];
    private byName = new Map<string, PluginEntry>();
    private listeners = new Map<string, Set<EventFn>>();
    private changeListeners = new Set<ChangeFn>();
    private booting = false;
    private readonly disabledNames: Set<string>;

    constructor(options: ContextOptions = {}) {
        this.log = options.log ?? defaultLogger;
        this.disabledNames = new Set(options.disabled ?? []);
    }

    provide<T>(name: string, value: T): void {
        this.services.set(name, value);
        this.unavailable.delete(name);
        const pending = this.waiters.get(name);
        if (pending) {
            this.waiters.delete(name);
            for (const w of pending) w.resolve(value);
        }
        this.log.info(`service provided: ${name}`);
    }

    get<T>(name: string): T {
        const value = this.services.get(name);
        if (value === undefined) throw new ServiceNotFoundError(name);
        return value as T;
    }

    inject<T>(name: string): T {
        return this.get<T>(name);
    }

    waitFor<T>(name: string): Promise<T> {
        const value = this.services.get(name);
        if (value !== undefined) return Promise.resolve(value as T);
        if (this.unavailable.has(name)) {
            return Promise.reject(new ServiceNotFoundError(name));
        }
        return new Promise<T>((resolve, reject) => {
            const list = this.waiters.get(name) ?? [];
            list.push({ resolve: resolve as (v: unknown) => void, reject });
            this.waiters.set(name, list);
        });
    }

    on(name: string, fn: EventFn): Dispose {
        const set = this.listeners.get(name) ?? new Set();
        set.add(fn);
        this.listeners.set(name, set);
        return () => {
            set.delete(fn);
        };
    }

    emit(name: string, payload?: unknown): void {
        const set = this.listeners.get(name);
        if (!set) return;
        for (const fn of set) fn(payload);
    }

    plugin(p: Plugin): void {
        const existing = this.byName.get(p.name);
        if (existing) {
            this.entries = this.entries.filter((e) => e !== existing);
        }
        const state = this.disabledNames.has(p.name) ? "disabled" : "enabled";
        const entry: PluginEntry = { plugin: p, state };
        this.entries.push(entry);
        this.byName.set(p.name, entry);
        if (this.booting) void this.startEntry(entry);
        this.notifyChange();
    }

    list(): PluginInfo[] {
        return this.entries.map((entry) => ({
            name: entry.plugin.name,
            description: entry.plugin.description,
            core: Boolean(entry.plugin.core),
            provides: entry.plugin.provides ?? [],
            inject: entry.plugin.inject ?? [],
            state: entry.state,
        }));
    }

    onPluginsChange(cb: ChangeFn): Dispose {
        this.changeListeners.add(cb);
        return () => {
            this.changeListeners.delete(cb);
        };
    }

    async disable(name: string): Promise<boolean> {
        const entry = this.byName.get(name);
        if (!entry || entry.plugin.core) return false;
        if (entry.state === "disabled" || entry.state === "stopped") {
            return false;
        }
        const targets = this.collectDependents(entry);
        targets.add(entry);
        for (const target of [...this.entries].reverse()) {
            if (!targets.has(target)) continue;
            if (target.state === "started" || target.state === "enabled") {
                await target.dispose?.();
                target.dispose = undefined;
            }
            target.state = "disabled";
            for (const svc of target.plugin.provides ?? []) {
                this.services.delete(svc);
                this.markUnavailable(svc);
            }
            this.log.info(`plugin disabled: ${target.plugin.name}`);
        }
        this.notifyChange();
        return true;
    }

    async enable(name: string): Promise<boolean> {
        const entry = this.byName.get(name);
        if (
            !entry ||
            (entry.state !== "disabled" && entry.state !== "failed")
        ) {
            return false;
        }
        const inject = entry.plugin.inject ?? [];
        if (!inject.every((dep) => this.services.has(dep))) return false;
        for (const svc of entry.plugin.provides ?? []) {
            this.unavailable.delete(svc);
        }
        entry.state = "enabled";
        if (this.booting) {
            return (await this.startEntry(entry)) === "started";
        }
        this.notifyChange();
        return true;
    }

    async start(): Promise<void> {
        this.booting = true;
        const declared = new Set<string>(this.services.keys());
        for (const entry of this.entries) {
            for (const svc of entry.plugin.provides ?? []) declared.add(svc);
            if (entry.state === "disabled") {
                for (const svc of entry.plugin.provides ?? []) {
                    this.markUnavailable(svc);
                }
            }
        }
        for (const entry of this.entries) {
            for (const dep of entry.plugin.inject ?? []) {
                if (!declared.has(dep)) this.markUnavailable(dep);
            }
        }
        await Promise.all(this.entries.map((entry) => this.startEntry(entry)));
    }

    async stop(): Promise<void> {
        this.booting = false;
        for (const entry of [...this.entries].reverse()) {
            if (entry.state !== "started") continue;
            await entry.dispose?.();
            entry.dispose = undefined;
            entry.state = "stopped";
            this.log.info(`plugin stopped: ${entry.plugin.name}`);
        }
        this.notifyChange();
    }

    private async startEntry(entry: PluginEntry): Promise<PluginState> {
        if (entry.state !== "enabled") return entry.state;
        try {
            if (entry.plugin.inject?.length) {
                await Promise.all(
                    entry.plugin.inject.map((name) => this.waitFor(name)),
                );
            }
            const dispose = await entry.plugin.apply(this);
            entry.dispose = dispose ?? undefined;
            entry.state = "started";
            this.log.info(`plugin started: ${entry.plugin.name}`);
        } catch (err) {
            entry.state = "failed";
            entry.dispose = undefined;
            this.log.error(`plugin failed: ${entry.plugin.name}`, err);
            for (const svc of entry.plugin.provides ?? []) {
                this.markUnavailable(svc);
            }
        }
        this.notifyChange();
        return entry.state;
    }

    private markUnavailable(name: string): void {
        this.unavailable.add(name);
        const pending = this.waiters.get(name);
        if (!pending) return;
        this.waiters.delete(name);
        for (const w of pending) w.reject(new ServiceNotFoundError(name));
    }

    private collectDependents(entry: PluginEntry): Set<PluginEntry> {
        const provides = new Set(entry.plugin.provides ?? []);
        const out = new Set<PluginEntry>();
        let grew = true;
        while (grew) {
            grew = false;
            for (const e of this.entries) {
                if (out.has(e) || e === entry) continue;
                const inject = e.plugin.inject ?? [];
                if (inject.some((dep) => provides.has(dep))) {
                    out.add(e);
                    for (const svc of e.plugin.provides ?? []) {
                        provides.add(svc);
                    }
                    grew = true;
                }
            }
        }
        return out;
    }

    private notifyChange(): void {
        for (const cb of this.changeListeners) cb();
    }
}
