import type { Context, Plugin } from "@plugim/core";
import { AutoPlugin } from "@plugim/core";
import type { AuthService, ChatService } from "@plugim/server/types";

@AutoPlugin()
export class ExamplePlugin implements Plugin {
    readonly name = "example";
    readonly description = "这是一个装饰器示例插件";

    async apply(ctx: Context) {
        const config = await ctx.getService<{ port?: number }>("config");
        const chat = await ctx.getService<ChatService>("chat");
        const auth = await ctx.getService<AuthService>("auth");

        ctx.provide("example-service", {
            hello: (name: string) => `Hello, ${name}!`,

            getServices: () => ({
                hasAuth: typeof auth === "object",
                hasChat: typeof chat === "object",
                configPort: config?.port ?? 0,
            }),
        });

        return undefined;
    }
}

export const ManualPlugin: Plugin = {
    name: "manual-example",
    inject: ["container"],
    async apply(ctx: Context) {
        ctx.provide("manual-service", true);
        return undefined;
    },
};
