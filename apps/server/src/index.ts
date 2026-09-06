import { Context } from "@plugim/core";
import { chatPlugin } from "./plugins/chat";
import { configPlugin } from "./plugins/config";
import { gatewayPlugin } from "./plugins/gateway";
import { storagePlugin } from "./plugins/storage";

const ctx = new Context();
ctx.plugin(configPlugin);
ctx.plugin(gatewayPlugin);
ctx.plugin(storagePlugin);
ctx.plugin(chatPlugin);

ctx.start().catch((err) => {
    ctx.log.error("failed to start:", err);
    process.exit(1);
});

process.on("SIGINT", async () => {
    await ctx.stop();
    process.exit(0);
});
