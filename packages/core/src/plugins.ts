import type { Context, Plugin } from "./index";

export interface AutoPluginMetadata {
    name: string;
}

export function AutoPlugin(): ClassDecorator & ((target: any) => void) {
    return (target: any) => {
        Reflect.defineMetadata("plugim:auto_plugin", true, target);
    };
}

export function getAutoPluginMetadata(instance: unknown): AutoPluginMetadata | undefined {
    const proto = Object.getPrototypeOf(instance);
    const isAutoPlugin = Reflect.getMetadata("plugim:auto_plugin", proto.constructor);
    if (!isAutoPlugin) return undefined;
    
    return {
        name: (instance as any).name || proto.constructor.name.toLowerCase(),
    };
}

export async function autoDiscoverPlugins(
    ctx: Context,
    pluginClasses?: any[]
): Promise<void> {
    if (!pluginClasses) {
        throw new Error("autoDiscoverPlugins requires explicit plugin classes");
    }

    for (const clazz of pluginClasses) {
        const instance = new clazz();
        const metadata = getAutoPluginMetadata(instance);
        if (metadata) {
            ctx.plugin(instance as Plugin);
        }
    }
}
