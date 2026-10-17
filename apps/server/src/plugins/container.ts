import type { Context, Plugin } from "@plugim/core";
import { Container } from "@plugim/core/container";

export interface ServiceLocator {
    get<T>(name: string): Promise<T>;
    getAll<T extends Record<string, unknown>>(names: string[]): Promise<T>;
    has(name: string): boolean;
}

export const containerPlugin: Plugin = {
    name: "container",
    description: "IoC 依赖注入容器",
    provides: ["container"],

    async apply(ctx) {
        const container = new Container();

        const originalProvide = ctx.provide.bind(ctx);

        ctx.provide = (name: string, value: unknown) => {
            originalProvide(name, value);

            container.register(name, {
                scope: "singleton",
                provider: async () => value,
            });
        };

        const enhancedCtx = ctx as Context & {
            __container?: Container;
            getService: <T>(name: string) => Promise<T>;
            getServiceOptional: <T>(name: string) => Promise<T | undefined>;
        };

        enhancedCtx.__container = container;

        enhancedCtx.getService = <T>(name: string): Promise<T> => {
            return container.get<T>(name, ctx);
        };

        enhancedCtx.getServiceOptional = async <T>(
            name: string,
        ): Promise<T | undefined> => {
            try {
                return await container.get<T>(name, ctx);
            } catch {
                return undefined;
            }
        };

        Object.assign(ctx, {
            getService: enhancedCtx.getService,
            getServiceOptional: enhancedCtx.getServiceOptional,
        });

        const serviceLocator: ServiceLocator = {
            get<T>(name: string): Promise<T> {
                if (!container.has(name)) {
                    throw new Error(`Service not found: ${name}`);
                }
                return container.get<T>(name, ctx);
            },

            getAll<T extends Record<string, unknown>>(
                names: string[],
            ): Promise<T> {
                return container.getAll<T>(names, ctx);
            },

            has(name: string): boolean {
                return container.has(name);
            },
        };

        ctx.provide("container", serviceLocator);

        ctx.log.info("IoC Container initialized");
        ctx.log.info("Usage in plugins:");
        ctx.log.info("  const db = ctx.getService<MessageStore>('store');");
        ctx.log.info("  const config = ctx.getService<AppConfig>('config');");
        ctx.log.info(
            "  const { gateway, auth } = ctx.getService<{gateway, auth}>(['gateway', 'auth']);",
        );

        return undefined;
    },
};
