import { AutoPlugin } from "./plugins";
import type { Plugin } from "./index";

@AutoPlugin()
export class HelloPlugin implements Plugin {
    readonly name = "hello";
    readonly description = "Hello World 插件";

    async apply(ctx) {
        ctx.provide("greeting", {
            hello: (name: string) => `Hello, ${name}!`,
        });
        return undefined;
    }
}

export const ManualPlugin: Plugin = {
    name: "manual",
    async apply(ctx) {
        ctx.provide("manual", true);
        return undefined;
    },
};
