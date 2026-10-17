import type { Context, Plugin } from "./index";

export interface AutoPluginMetadata {
    name: string;
}

const decoratedPlugins = new WeakMap<object, true>();

export function AutoPlugin(): ClassDecorator & ((target: any) => void) {
    return (target: any) => {
        decoratedPlugins.set(target, true);
    };
}

export function getAutoPluginMetadata(
    instance: unknown,
): AutoPluginMetadata | undefined {
    if (instance === null || instance === undefined) return undefined;
    const proto = Object.getPrototypeOf(instance) as {
        constructor?: Function;
    } | null;
    const ctor = proto?.constructor;
    if (!ctor || !decoratedPlugins.has(ctor)) return undefined;

    return {
        name: (instance as { name?: string }).name || ctor.name.toLowerCase(),
    };
}

export async function autoDiscoverPlugins(
    ctx: Context,
    candidates?: Array<Plugin | (new () => unknown)>,
): Promise<void> {
    if (!candidates) {
        throw new Error("autoDiscoverPlugins requires explicit plugins");
    }

    for (const candidate of candidates) {
        const fromClass = typeof candidate === "function";
        const instance = fromClass
            ? new (candidate as new () => unknown)()
            : candidate;

        if (!instance || typeof (instance as Plugin).apply !== "function") {
            continue;
        }

        if (fromClass && !getAutoPluginMetadata(instance)) {
            continue;
        }

        ctx.plugin(instance as Plugin);
    }
}
