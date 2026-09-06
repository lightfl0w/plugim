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
    inject?: string[];
    apply(ctx: Context): Promise<Dispose | undefined>;
}

export class ServiceNotFoundError extends Error {
    constructor(public readonly name: string) {
        super(`service not found: ${name}`);
    }
}

type EventFn = (payload: unknown) => void;
type ServiceWaiter = (value: unknown) => void;

interface PluginEntry {
    plugin: Plugin;
    dispose?: Dispose;
}

export class Context {
    readonly log: Logger;
    private services = new Map<string, unknown>();
    private waiters = new Map<string, ServiceWaiter[]>();
    private entries: PluginEntry[] = [];
    private listeners = new Map<string, Set<EventFn>>();

    constructor(log: Logger = defaultLogger) {
        this.log = log;
    }

    provide<T>(name: string, value: T): void {
        this.services.set(name, value);
        const pending = this.waiters.get(name);
        if (pending) {
            this.waiters.delete(name);
            for (const w of pending) w(value);
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
        return new Promise<T>((resolve) => {
            const list = this.waiters.get(name) ?? [];
            list.push(resolve as ServiceWaiter);
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
        this.entries.push({ plugin: p });
    }

    async start(): Promise<void> {
        for (const entry of this.entries) {
            const { plugin } = entry;
            if (plugin.inject?.length) {
                await Promise.all(
                    plugin.inject.map((name) => this.waitFor(name)),
                );
            }
            const dispose = await plugin.apply(this);
            entry.dispose = dispose ?? undefined;
            this.log.info(`plugin started: ${plugin.name}`);
        }
    }

    async stop(): Promise<void> {
        for (const entry of [...this.entries].reverse()) {
            await entry.dispose?.();
            this.log.info(`plugin stopped: ${entry.plugin.name}`);
        }
    }
}
