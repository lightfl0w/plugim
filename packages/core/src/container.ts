import type { Context } from "./index";

declare module "./index" {
    interface Context {
        getService<T>(name: string): Promise<T>;
        getServiceOptional<T>(name: string): Promise<T | undefined>;
    }
}

export interface InjectableMetadata {
    serviceName: string;
    scope: "singleton" | "transient";
    injects: Array<{ serviceName: string; optional?: boolean }>;
}

const injectableRegistry = new WeakMap<Function, InjectableMetadata>();

const paramInjectRegistry = new WeakMap<
    object,
    Map<
        string,
        { serviceName: string; optional?: boolean; defaultValue?: unknown }
    >
>();

export interface ContainerOptions {
    parent?: Container;
    strict?: boolean;
}

export interface ServiceDefinition<T = unknown> {
    provider: ProviderFunction<T>;
    scope: "singleton" | "transient";
    dependencies?: string[];
}

export type ProviderFunction<T = unknown> = (
    ctx: Context,
    deps: Record<string, unknown>,
) => T;

export class ServiceNotRegisteredError extends Error {
    constructor(
        public readonly name: string,
        public readonly container: string,
    ) {
        super(`Service "${name}" not registered in ${container}`);
    }
}

export class CircularDependencyError extends Error {
    constructor(public readonly chain: string[]) {
        const path = chain.join(" → ");
        super(`Circular dependency detected: ${path}`);
    }
}

export class ServiceInitializationError extends Error {
    constructor(serviceName: string, cause: Error) {
        super(
            `Failed to initialize service "${serviceName}": ${cause.message}`,
        );
        this.cause = cause;
    }

    readonly cause?: Error;
}

export class Container {
    private services = new Map<string, ServiceDefinition>();
    private instances = new Map<string, unknown>();
    private readonly options: ContainerOptions;

    constructor(options: ContainerOptions = {}) {
        this.options = options;
    }

    register<T>(name: string, definition: ServiceDefinition<T>): void {
        if (this.services.has(name)) {
            throw new Error(`Service "${name}" already registered`);
        }

        this.services.set(name, {
            ...definition,
            dependencies: definition.dependencies ?? [],
        });
    }

    async get<T>(name: string, ctx: Context): Promise<T> {
        return this.resolve<T>(name, ctx);
    }

    async getAll<T extends Record<string, unknown>>(
        names: string[],
        ctx: Context,
    ): Promise<T> {
        const result = {} as T;
        for (const name of names) {
            result[name as keyof T] = await this.get<T[keyof T]>(name, ctx);
        }
        return result;
    }

    has(name: string): boolean {
        return this.services.has(name);
    }

    clear(): void {
        for (const [name, def] of this.services) {
            if (def.scope === "singleton") {
                this.instances.delete(name);
            }
        }
    }

    private async resolve<T>(name: string, ctx: Context): Promise<T> {
        const definition = this.services.get(name);

        if (!definition && this.options.parent) {
            return this.options.parent.get<T>(name, ctx);
        }

        if (!definition) {
            if (this.options.strict) {
                throw new ServiceNotRegisteredError(
                    name,
                    `container_${hashCode(this)}`,
                );
            }
            return undefined as unknown as T;
        }

        const cached = this.instances.get(name);
        if (cached !== undefined) {
            return cached as T;
        }

        const deps = await this.buildDepsGraph(definition, ctx);

        try {
            const instance = await definition.provider(ctx, deps);

            if (definition.scope === "singleton") {
                this.instances.set(name, instance);
            }

            return instance as T;
        } catch (err) {
            throw new ServiceInitializationError(name, err as Error);
        }
    }

    private async buildDepsGraph(
        definition: ServiceDefinition,
        ctx: Context,
        visiting: Set<string> = new Set(),
    ): Promise<Record<string, unknown>> {
        const result: Record<string, unknown> = {};

        for (const depName of definition.dependencies ?? []) {
            if (visiting.has(depName)) {
                const chain = Array.from(visiting).concat(depName);
                throw new CircularDependencyError(chain);
            }

            visiting.add(depName);
            result[depName] = await this.resolve(depName, ctx);
            visiting.delete(depName);
        }

        return result;
    }
}

export function Inject(
    serviceName: string,
    options: { optional?: boolean; defaultValue?: unknown } = {},
): ParameterDecorator {
    return (target, key, index) => {
        const owner = target.constructor as object;
        const entries = paramInjectRegistry.get(owner) ?? new Map();
        entries.set(`${String(key)}:${index}`, {
            serviceName,
            ...options,
        });
        paramInjectRegistry.set(owner, entries);
    };
}

export function Injectable(
    options: { name?: string; scope?: "singleton" | "transient" } = {},
) {
    return <T extends new (...args: any[]) => any>(ctor: T): T => {
        injectableRegistry.set(ctor, {
            serviceName: options.name || ctor.name.toLowerCase(),
            scope: options.scope || "singleton",
            injects: [],
        });

        return ctor;
    };
}

export function extractInjectMetadata(ctor: Function): InjectableMetadata {
    const meta = injectableRegistry.get(ctor);
    if (!meta) {
        throw new Error(`Class ${ctor.name} is not decorated with @Injectable`);
    }

    return meta;
}

function hashCode(obj: object): number {
    const text = obj.toString();
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = (hash << 5) - hash + text.charCodeAt(i);
    }
    return hash & hash;
}
