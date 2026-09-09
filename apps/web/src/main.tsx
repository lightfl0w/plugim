import { Context } from "@plugim/core";
import { mountHost } from "./host";
import { globalPlugins, loadDisabledPlugins } from "./plugins/registry";
import "./index.css";

const ctx = new Context({ disabled: loadDisabledPlugins() });

declare global {
    interface Window {
        __ctx?: Context;
    }
}
window.__ctx = ctx;

mountHost(ctx);
for (const plugin of globalPlugins) {
    ctx.plugin(plugin);
}
void ctx.start();
