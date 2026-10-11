import { AutoPlugin } from "@plugim/core";
import type { Plugin } from "@plugim/core";

@AutoPlugin()
export class ExamplePlugin implements Plugin {
    readonly name = "example";
    readonly description = "这是一个装饰器示例插件";

    async apply(ctx) {
        ctx.provide("example-service", {
            hello: (name: string) => `Hello, ${name}!`,
        });
        return undefined;
    }
}

export const ManualPlugin: Plugin = {
    name: "manual-example",
    async apply(ctx) {
        ctx.provide("manual-service", true);
        return undefined;
    },
};
