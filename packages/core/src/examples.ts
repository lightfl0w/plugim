import type { Context, Plugin } from "./index";
import { AutoPlugin } from "./plugins";

@AutoPlugin()
export class HelloPlugin implements Plugin {
    readonly name = "hello";
    readonly description = "Hello World 插件";

    async apply(ctx: Context) {
        ctx.provide("greeting", {
            hello: (name: string) => `Hello, ${name}!`,
        });
        return undefined;
    }
}

export const ManualPlugin: Plugin = {
    name: "manual",
    async apply(ctx: Context) {
        ctx.provide("manual", true);
        return undefined;
    },
};
