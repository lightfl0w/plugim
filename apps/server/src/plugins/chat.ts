import type { Plugin } from "@plugim/core";
import type { HistoryParams, SendMessageParams } from "@plugim/protocol";
import type { GatewayService, MessageStore } from "../types";
import type { AppConfig } from "./config";

export const chatPlugin: Plugin = {
    name: "chat",
    inject: ["gateway", "store", "config"],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const store = ctx.get<MessageStore>("store");
        const config = ctx.get<AppConfig>("config");

        gateway.rpc("message.send", async (raw) => {
            const params = raw as unknown as SendMessageParams;
            if (!params.sender || !params.content)
                throw new Error("sender and content are required");
            const session = params.session || config.defaultSession;
            const saved = await store.save({
                session,
                sender: params.sender,
                content: params.content,
            });
            gateway.broadcast("message:new", { message: saved });
            return saved;
        });

        gateway.rpc("history.list", (raw) => {
            const params = raw as unknown as HistoryParams;
            return store.list(
                params.session || config.defaultSession,
                Math.min(Number(params.limit ?? 50), 200),
            );
        });
        return undefined;
    },
};
