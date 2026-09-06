import type { Plugin } from "@plugim/core";
import type { ChatMessage } from "@plugim/protocol";
import type { RpcService } from "./connection";

export const echoBotPlugin: Plugin = {
    name: "echo-bot",
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        ctx.on("server:message:new", (payload) => {
            const message = (payload as { message: ChatMessage }).message;
            if (message.sender === "bot") return;
            void rpc
                .call("message.send", {
                    session: message.session,
                    sender: "bot",
                    content: `echo: ${message.content}`,
                })
                .catch((err) => ctx.log.warn("echo-bot failed:", err));
        });
        return undefined;
    },
};
